import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { randomToken } from '../lib/security';
import { signAccessToken, signPayload, verifyToken } from '../lib/jwt';
import { assertIssuer, authorizationUrl, discover, pkcePair, redeemCode } from '../lib/oidc';
import { loadAvailableRoles } from '../services/accounts';
import { startSessionFor } from './auth';
import type { DbOrTrx, Trx } from '../db';

const ADMIN = requireRole('superAdmin', 'admin');
const TX_COOKIE = 'sso_tx';
const MFA_AMR = new Set(['mfa', 'otp', 'hwk']);

async function userInCompany(db: DbOrTrx, userId: number, companyId: number): Promise<boolean> {
  const e = await db
    .selectFrom('employee')
    .select('employee_id')
    .where('user_id', '=', userId)
    .where('company_id', '=', companyId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (e) return true;
  const a = await db
    .selectFrom('admin as a')
    .innerJoin('admin_company as ac', 'ac.admin_id', 'a.admin_id')
    .select('a.admin_id')
    .where('a.user_id', '=', userId)
    .where('ac.company_id', '=', companyId)
    .executeTakeFirst();
  if (a) return true;
  const m = await db
    .selectFrom('manager as m')
    .innerJoin('manager_hotel as mh', 'mh.manager_id', 'm.manager_id')
    .innerJoin('hotel as h', 'h.id', 'mh.hotel_id')
    .select('m.manager_id')
    .where('m.user_id', '=', userId)
    .where('h.company_id', '=', companyId)
    .executeTakeFirst();
  return !!m;
}

export async function ssoRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);
  const prod = app.cfg.NODE_ENV === 'production';
  const redirectUri = `${app.cfg.WEB_ORIGIN.replace(/\/+$/, '')}/api/v1/auth/sso/callback`;
  const webUrl = (path: string) => `${app.cfg.WEB_ORIGIN.replace(/\/+$/, '')}${path}`;
  const authLimit = { rateLimit: { max: app.cfg.RATE_LIMIT_AUTH, timeWindow: '1 minute' } };

  // ---------------------------------------------------------------- configuration (administrators)
  const out = (p: any) => ({
    companyId: p.company_id,
    issuer: p.issuer,
    clientId: p.client_id,
    enabled: p.enabled,
    redirectUri,
  });
  r.get(
    '/sso/provider',
    {
      preValidation: ADMIN,
      schema: { querystring: z.object({ companyId: z.coerce.number().int().positive() }) },
    },
    async (req) => {
      getPrincipal(req).scope.assertCompany(req.query.companyId);
      const p = await db
        .selectFrom('sso_provider')
        .selectAll()
        .where('company_id', '=', req.query.companyId)
        .executeTakeFirst();
      return p ? out(p) : { companyId: req.query.companyId, configured: false, redirectUri };
    },
  );
  r.put(
    '/sso/provider',
    {
      preValidation: ADMIN,
      schema: {
        body: z.object({
          companyId: z.number().int().positive(),
          issuer: z.string().url().max(500),
          clientId: z.string().min(1).max(300),
          clientSecret: z.string().min(1).max(500).optional(),
          enabled: z.boolean().default(true),
        }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      const b = req.body;
      p.scope.assertCompany(b.companyId);
      assertIssuer(b.issuer, prod);
      await discover(b.issuer); // refuse a configuration that cannot work
      return tx(async (trx) => {
        const old = await trx
          .selectFrom('sso_provider')
          .selectAll()
          .where('company_id', '=', b.companyId)
          .executeTakeFirst();
        if (!old && !b.clientSecret) throw new AppError('VALIDATION', 'The client secret is required');
        const enc = b.clientSecret
          ? app.keys.seal('sso-client-secret', b.clientSecret)
          : old!.client_secret_enc;
        const row = await trx
          .insertInto('sso_provider')
          .values({
            company_id: b.companyId,
            issuer: b.issuer.replace(/\/+$/, ''),
            client_id: b.clientId,
            client_secret_enc: enc,
            enabled: b.enabled,
          })
          .onConflict((oc) =>
            oc.column('company_id').doUpdateSet({
              issuer: b.issuer.replace(/\/+$/, ''),
              client_id: b.clientId,
              client_secret_enc: enc,
              enabled: b.enabled,
            }),
          )
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: old ? 'sso_provider_updated' : 'sso_provider_created',
          entityType: 'sso_provider',
          entityId: row.id,
          companyId: b.companyId,
          old: old ? out(old) : undefined,
          new: out(row),
        });
        return out(row);
      });
    },
  );
  r.delete(
    '/sso/provider',
    {
      preValidation: ADMIN,
      schema: { querystring: z.object({ companyId: z.coerce.number().int().positive() }) },
    },
    async (req, reply) => {
      getPrincipal(req).scope.assertCompany(req.query.companyId);
      await tx(async (trx) => {
        const old = await trx
          .selectFrom('sso_provider')
          .selectAll()
          .where('company_id', '=', req.query.companyId)
          .executeTakeFirst();
        if (!old) return;
        await trx.deleteFrom('sso_provider').where('id', '=', old.id).execute();
        await audit(trx, actorOf(req), {
          action: 'sso_provider_deleted',
          entityType: 'sso_provider',
          entityId: old.id,
          companyId: old.company_id,
          old: out(old),
        });
      });
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------- login flow
  const failRedirect = (reply: any, code: string) => {
    reply.clearCookie(TX_COOKIE, { path: '/api/v1/auth/sso' });
    return reply.redirect(webUrl(`/login?sso_error=${encodeURIComponent(code)}`));
  };

  r.get(
    '/auth/sso/start',
    { config: authLimit, schema: { querystring: z.object({ company: z.coerce.number().int().positive() }) } },
    async (req, reply) => {
      const p = await db
        .selectFrom('sso_provider')
        .selectAll()
        .where('company_id', '=', req.query.company)
        .where('enabled', '=', true)
        .executeTakeFirst();
      if (!p) return failRedirect(reply, 'not_configured');
      let d;
      try {
        d = await discover(p.issuer);
      } catch {
        return failRedirect(reply, 'idp_unreachable');
      }
      const { verifier, challenge } = pkcePair();
      const state = randomToken();
      const nonce = randomToken();
      const txToken = await signPayload(
        app.keys.signing('sso'),
        { kind: 'sso_tx', state, nonce, verifier, company: p.company_id },
        '10m',
      );
      reply.setCookie(TX_COOKIE, txToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: app.cfg.COOKIE_SECURE,
        path: '/api/v1/auth/sso',
        maxAge: 600,
      });
      return reply.redirect(
        authorizationUrl(d, { clientId: p.client_id, redirectUri, state, nonce, challenge }),
      );
    },
  );

  r.get(
    '/auth/sso/callback',
    {
      config: authLimit,
      schema: {
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
        }),
      },
    },
    async (req, reply) => {
      const raw = req.cookies[TX_COOKIE];
      const c = raw
        ? await verifyToken<{
            kind?: string;
            state?: string;
            nonce?: string;
            verifier?: string;
            company?: number;
          }>(app.keys.verifying('sso'), raw)
        : null;
      if (!c || c.kind !== 'sso_tx' || !c.company) return failRedirect(reply, 'expired');
      if (req.query.error || !req.query.code || req.query.state !== c.state)
        return failRedirect(reply, 'denied');
      const p = await db
        .selectFrom('sso_provider')
        .selectAll()
        .where('company_id', '=', c.company)
        .where('enabled', '=', true)
        .executeTakeFirst();
      if (!p) return failRedirect(reply, 'not_configured');
      let claims;
      try {
        const d = await discover(p.issuer);
        claims = await redeemCode(d, {
          clientId: p.client_id,
          clientSecret: app.keys.openText('sso-client-secret', p.client_secret_enc),
          code: req.query.code,
          redirectUri,
          verifier: c.verifier!,
          nonce: c.nonce!,
        });
      } catch (e) {
        req.log.warn({ code: (e as AppError).code }, 'sso callback failed');
        return failRedirect(reply, 'idp_error');
      }
      const result = await tx(async (trx) => {
        let userId: number | null =
          (
            await trx
              .selectFrom('sso_identity')
              .select('user_id')
              .where('provider_id', '=', p.id)
              .where('subject', '=', claims.sub)
              .executeTakeFirst()
          )?.user_id ?? null;
        let linked = false;
        if (!userId) {
          // first login: link by a verified e-mail address to an existing account of this company; never create accounts
          if (!claims.email || claims.email_verified !== true) return { error: 'no_account' as const };
          const u = await trx
            .selectFrom('user_account')
            .select('id')
            .where((eb) => eb(eb.fn('lower', ['email']), '=', claims.email!.toLowerCase()))
            .where('status', '=', 'active')
            .executeTakeFirst();
          if (!u || !(await userInCompany(trx, u.id, p.company_id))) return { error: 'no_account' as const };
          const taken = await trx
            .selectFrom('sso_identity')
            .select('id')
            .where('provider_id', '=', p.id)
            .where('user_id', '=', u.id)
            .executeTakeFirst();
          if (taken) return { error: 'no_account' as const }; // this account is already tied to another identity
          await trx
            .insertInto('sso_identity')
            .values({ provider_id: p.id, user_id: u.id, subject: claims.sub })
            .execute();
          userId = u.id;
          linked = true;
        }
        const user = await trx
          .selectFrom('user_account')
          .select(['id', 'status'])
          .where('id', '=', userId)
          .executeTakeFirstOrThrow();
        if (user.status !== 'active') return { error: 'no_account' as const };
        await trx
          .updateTable('user_account')
          .set({ last_login_at: app.clock() })
          .where('id', '=', userId)
          .execute();
        await audit(
          trx,
          { userId, type: 'system', ip: req.ip, userAgent: req.headers['user-agent'] },
          {
            action: linked ? 'sso_linked' : 'sso_login',
            entityType: 'user_account',
            entityId: userId,
            companyId: p.company_id,
          },
        );
        return { userId };
      });
      if ('error' in result) return failRedirect(reply, result.error ?? 'no_account');
      const mfa = (claims.amr ?? []).some((a) => MFA_AMR.has(a));
      const ticket = await signPayload(
        app.keys.signing('sso'),
        { kind: 'sso_ticket', uid: result.userId, mfa, jti: randomUUID() },
        '2m',
      );
      reply.clearCookie(TX_COOKIE, { path: '/api/v1/auth/sso' });
      return reply.redirect(webUrl(`/login/sso#ticket=${ticket}`));
    },
  );

  /** The web app trades the ticket for the same answer the password login gives. */
  r.post(
    '/auth/sso/exchange',
    { config: authLimit, schema: { body: z.object({ ticket: z.string().min(10).max(2000) }) } },
    async (req, reply) => {
      const c = await verifyToken<{ kind?: string; uid?: number; mfa?: boolean; jti?: string }>(
        app.keys.verifying('sso'),
        req.body.ticket,
      );
      if (!c || c.kind !== 'sso_ticket' || !c.uid || !c.jti)
        throw new AppError('UNAUTHENTICATED', 'The sign-in expired. Please try again.');
      const used = await db
        .insertInto('sso_ticket_use')
        .values({ jti: c.jti })
        .onConflict((oc) => oc.doNothing())
        .returning('jti')
        .executeTakeFirst();
      if (!used) throw new AppError('UNAUTHENTICATED', 'The sign-in was already used');
      const user = await db
        .selectFrom('user_account')
        .select(['id', 'status'])
        .where('id', '=', c.uid)
        .executeTakeFirst();
      if (!user || user.status !== 'active') throw new AppError('UNAUTHENTICATED', 'Account is not active');
      const { roles: all, name } = await loadAvailableRoles(db, user.id);
      // The identity provider's MFA replaces the local second factor, so administrators may only come in with it.
      // Super admins always use the password login.
      const roles = all.filter((x) => x.role !== 'superAdmin' && (x.role !== 'admin' || c.mfa === true));
      if (!roles.length)
        throw new AppError('FORBIDDEN_SCOPE', 'This account cannot sign in with single sign-on', {
          adminNeedsMfa: all.some((x) => x.role === 'admin') && !c.mfa,
        });
      await audit(
        db,
        { userId: user.id, type: 'system', ip: req.ip, userAgent: req.headers['user-agent'] },
        {
          action: 'sso_exchange',
          entityType: 'user_account',
          entityId: user.id,
        },
      );
      const base = { availableRoles: roles, displayName: name };
      if (roles.length === 1) {
        const s = await startSessionFor(app, req, reply, user.id, roles[0].role, roles[0].employeeId ?? null);
        return { ...base, accessToken: s.accessToken };
      }
      const preToken = await signAccessToken(
        app.keys.signing('access'),
        { sub: user.id, pre: true, ssoMfa: c.mfa === true },
        '10m',
      );
      return { ...base, preToken, twoFactorSetupRequired: false };
    },
  );
}
