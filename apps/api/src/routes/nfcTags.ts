import type { NfcTagDto } from '@dienst/shared';
import type { DB } from '../db';
import type { Selectable } from 'kysely';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { randomToken, sha256 } from '../lib/security';
import { csvIds, idParam } from '../lib/http';
import type { Trx } from '../db';

/**
 * What is written to a tag: an ordinary web address of this installation. The Android app claims such links;
 * on any other phone it opens the browser, where the same punch page works.
 */
export const nfcUrl = (origin: string, token: string) => `${origin.replace(/\/+$/, '')}/nfc?t=${token}`;

export async function nfcTagRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);
  const admins = requireRole('superAdmin', 'admin');

  const tagOut = (t: Selectable<DB['hotel_nfc_tag']>): NfcTagDto => ({
    id: t.id,
    hotelId: t.hotel_id,
    label: t.label,
    createdAt: new Date(t.created_at).toISOString(),
    revokedAt: t.revoked_at ? new Date(t.revoked_at).toISOString() : null,
  });

  // The token is shown once, like a tablet token: only its hash is stored.
  r.post(
    '/nfc-tags',
    {
      preValidation: admins,
      schema: { body: z.object({ hotelId: z.number().int().positive(), label: z.string().min(1).max(100) }) },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      p.scope.assertHotel(req.body.hotelId);
      const token = `nt_${randomToken()}`;
      const row = await tx(async (trx) => {
        const t = await trx
          .insertInto('hotel_nfc_tag')
          .values({
            hotel_id: req.body.hotelId,
            label: req.body.label,
            token_hash: sha256(token),
            created_by_user_id: p.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'nfc_tag_created',
          entityType: 'hotel_nfc_tag',
          entityId: t.id,
          hotelId: t.hotel_id,
          new: { label: t.label },
        });
        return t;
      });
      return reply.status(201).send({ ...tagOut(row), token, url: nfcUrl(app.cfg.WEB_ORIGIN, token) });
    },
  );

  r.get(
    '/nfc-tags',
    { preValidation: admins, schema: { querystring: z.object({ hotelId: csvIds }) } },
    async (req) => {
      const hotels = getPrincipal(req).scope.hotels(req.query.hotelId);
      const rows = hotels.length
        ? await db
            .selectFrom('hotel_nfc_tag')
            .selectAll()
            .where('hotel_id', 'in', hotels)
            .orderBy('id')
            .execute()
        : [];
      return { items: rows.map(tagOut) };
    },
  );

  // DELETE revokes the tag: the row stays for the audit trail, the token stops working at once
  r.delete('/nfc-tags/:id', { preValidation: admins, schema: { params: idParam } }, async (req, reply) => {
    const p = getPrincipal(req);
    await tx(async (trx) => {
      const old = await trx
        .selectFrom('hotel_nfc_tag')
        .selectAll()
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!old) throw notFound('NFC tag');
      p.scope.assertHotel(old.hotel_id);
      if (old.revoked_at) return;
      await trx
        .updateTable('hotel_nfc_tag')
        .set({ revoked_at: app.clock() })
        .where('id', '=', old.id)
        .execute();
      await audit(trx, actorOf(req), {
        action: 'nfc_tag_revoked',
        entityType: 'hotel_nfc_tag',
        entityId: old.id,
        hotelId: old.hotel_id,
        old: { label: old.label },
      });
    });
    return reply.status(204).send();
  });
}
