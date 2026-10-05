import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { idParam } from '../lib/http';
import { registrationOptions, verifyRegistration } from '../lib/webauthn';

const staff = requireRole('superAdmin', 'admin', 'manager');

/** Security keys and passkeys of the signed-in staff member. The login side lives in `routes/auth.ts`. */
export async function webauthnRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const limit = { rateLimit: { max: app.cfg.RATE_LIMIT_AUTH, timeWindow: '1 minute' } };

  const mine = (userId: number) =>
    db
      .selectFrom('webauthn_credential')
      .select(['id', 'credential_id', 'name', 'transports', 'created_at', 'last_used_at'])
      .where('user_id', '=', userId)
      .orderBy('id');

  r.get('/auth/webauthn/credentials', { preValidation: staff }, async (req) => {
    const rows = await mine(getPrincipal(req).userId).execute();
    return {
      items: rows.map((c) => ({
        id: c.id,
        name: c.name,
        transports: c.transports ?? [],
        createdAt: c.created_at.toISOString(),
        lastUsedAt: c.last_used_at?.toISOString() ?? null,
      })),
    };
  });

  r.post('/auth/webauthn/register/options', { preValidation: staff, config: limit }, async (req) => {
    const p = getPrincipal(req);
    const u = await db
      .selectFrom('user_account')
      .select(['id', 'email', 'username'])
      .where('id', '=', p.userId)
      .executeTakeFirstOrThrow();
    const existing = await mine(p.userId).execute();
    return registrationOptions(app, { id: u.id, label: u.email ?? u.username ?? `user${u.id}` }, existing);
  });

  r.post(
    '/auth/webauthn/register/verify',
    {
      preValidation: staff,
      config: limit,
      schema: {
        body: z.object({
          challengeToken: z.string().min(10).max(2000),
          name: z.string().trim().min(1).max(80),
          response: z.object({ id: z.string(), rawId: z.string() }).passthrough(),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const info = await verifyRegistration(
        app,
        p.userId,
        req.body.challengeToken,
        req.body.response as never,
      );
      const dup = await db
        .selectFrom('webauthn_credential')
        .select('id')
        .where('credential_id', '=', info.credentialId)
        .executeTakeFirst();
      if (dup) throw new AppError('CONFLICT', 'This security key is already registered');
      const row = await db.transaction().execute(async (trx) => {
        const c = await trx
          .insertInto('webauthn_credential')
          .values({
            user_id: p.userId,
            credential_id: info.credentialId,
            public_key: info.publicKey,
            counter: info.counter,
            transports: info.transports,
            name: req.body.name,
          })
          .returning(['id', 'name', 'created_at'])
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'webauthn_registered',
          entityType: 'user_account',
          entityId: p.userId,
          new: { credentialRowId: c.id, name: c.name },
        });
        return c;
      });
      return reply.status(201).send({ id: row.id, name: row.name, createdAt: row.created_at.toISOString() });
    },
  );

  r.delete(
    '/auth/webauthn/credentials/:id',
    { preValidation: staff, schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      const own = await mine(p.userId).execute();
      const c = own.find((x) => x.id === req.params.id);
      if (!c) throw notFound('Security key');
      const u = await db
        .selectFrom('user_account')
        .select('totp_enabled')
        .where('id', '=', p.userId)
        .executeTakeFirstOrThrow();
      // administrators must keep a second factor: the last key can only go while the authenticator app is set up
      if ((p.role === 'admin' || p.role === 'superAdmin') && own.length === 1 && !u.totp_enabled)
        throw new AppError('CONFLICT', 'This is your only second factor. Set up an authenticator app first.');
      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom('webauthn_credential').where('id', '=', c.id).execute();
        await audit(trx, actorOf(req), {
          action: 'webauthn_removed',
          entityType: 'user_account',
          entityId: p.userId,
          old: { credentialRowId: c.id, name: c.name },
        });
      });
      return reply.status(204).send();
    },
  );
}
