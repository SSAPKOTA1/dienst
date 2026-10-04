import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import type { Role } from '@dienst/shared';
import { AppError } from '../lib/errors';
import {
  assertPasswordPolicy,
  decryptSecret,
  encryptSecret,
  hashSecret,
  randomToken,
  sha256,
  verifySecret,
} from '../lib/security';
import { signAccessToken } from '../lib/jwt';
import { actorOf, getPrincipal, requirePreOrAccess, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { buildPrincipal, roleToActorType } from '../lib/scope';
import { loadAvailableRoles } from '../services/accounts';
import { resetMail } from '../lib/mail';

authenticator.options = { window: 1 };

const COOKIE = 'rt';
const REFRESH_TTL_MS = 30 * 24 * 3600e3;
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60e3;
// real argon2id hash, used to equalise timing when the account does not exist
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashSecret('timing-equaliser'));

const roleSchema = z.enum(['superAdmin', 'admin', 'manager', 'employee']);

export async function authRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const authLimit = { rateLimit: { max: app.cfg.RATE_LIMIT_AUTH, timeWindow: '1 minute' } };

  async function startSession(
    req: FastifyRequest,
    reply: FastifyReply,
    userId: number,
    role: Role,
    employeeId: number | null,
  ) {
    const principal = await buildPrincipal(app.db, userId, role, employeeId);
    if (!principal) throw new AppError('FORBIDDEN_SCOPE', 'Role is not available for this account');
    const raw = randomToken();
    await app.db
      .insertInto('refresh_token')
      .values({
        user_id: userId,
        token_hash: sha256(raw),
        active_role: role,
        active_employee_id: employeeId,
        expires_at: new Date(app.clock().getTime() + REFRESH_TTL_MS),
      })
      .execute();
    reply.setCookie(COOKIE, raw, {
      httpOnly: true,
      sameSite: 'lax',
      secure: app.cfg.COOKIE_SECURE,
      path: '/api/v1/auth',
      maxAge: REFRESH_TTL_MS / 1000,
    });
    const accessToken = await signAccessToken(app.cfg.JWT_SECRET, {
      sub: userId,
      role,
      employeeId: principal.employeeId ?? undefined,
      companyIds: role === 'admin' ? principal.scope.companyIds : undefined,
      hotelIds: role === 'manager' || role === 'employee' ? principal.scope.hotelIds : undefined,
    });
    return { accessToken, role, employeeId: principal.employeeId };
  }

  const isStaffAdmin = (roles: { role: string }[]) =>
    roles.some((x) => x.role === 'superAdmin' || x.role === 'admin');

  // ---- login --------------------------------------------------------------------------------
  r.post(
    '/auth/login',
    {
      config: authLimit,
      schema: {
        body: z.object({
          login: z.string().min(1).max(255),
          password: z.string().min(1).max(200),
          totp: z.string().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { login, password, totp } = req.body;
      const now = app.clock();
      const user = await app.db
        .selectFrom('user_account')
        .selectAll()
        .where((eb) =>
          eb.or([
            eb(eb.fn('lower', ['email']), '=', login.toLowerCase()),
            eb(eb.fn('lower', ['username']), '=', login.toLowerCase()),
          ]),
        )
        .executeTakeFirst();
      const fail = async (reason: string, userId?: number) => {
        await audit(
          app.db,
          { userId: userId ?? null, type: 'system', ip: req.ip, userAgent: req.headers['user-agent'] },
          {
            action: 'login_failed',
            entityType: 'user_account',
            entityId: userId ?? null,
            status: 'failed',
            reason,
          },
        );
        throw new AppError('UNAUTHENTICATED', 'Invalid credentials');
      };
      if (!user || !user.password_hash) {
        await verifySecret(await getDummyHash(), password);
        return fail('unknown_or_inactive', user?.id);
      }
      if (user.locked_until && user.locked_until > now) return fail('locked', user.id);
      if (user.status !== 'active') return fail('inactive', user.id);
      if (!(await verifySecret(user.password_hash, password))) {
        const count = user.failed_login_count + 1;
        await app.db
          .updateTable('user_account')
          .set({
            failed_login_count: count,
            locked_until: count >= MAX_FAILED ? new Date(now.getTime() + LOCK_MS) : null,
          })
          .where('id', '=', user.id)
          .execute();
        return fail('bad_password', user.id);
      }
      const { roles, name } = await loadAvailableRoles(app.db, user.id);
      if (!roles.length) return fail('no_role', user.id);
      const staffAdmin = isStaffAdmin(roles);
      if (staffAdmin && user.totp_enabled) {
        if (!totp)
          throw new AppError('UNAUTHENTICATED', 'Authentication code required', { totpRequired: true });
        const secret = decryptSecret(user.totp_secret_enc as Buffer, app.cfg.TOTP_ENC_KEY);
        if (!authenticator.check(totp, secret)) return fail('bad_totp', user.id);
      }
      await app.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('user_account')
          .set({ failed_login_count: 0, locked_until: null, last_login_at: now })
          .where('id', '=', user.id)
          .execute();
        await audit(
          trx,
          { userId: user.id, type: 'system', ip: req.ip, userAgent: req.headers['user-agent'] },
          {
            action: 'login',
            entityType: 'user_account',
            entityId: user.id,
          },
        );
      });
      const twoFactorSetupRequired = staffAdmin && !user.totp_enabled;
      const base = { availableRoles: roles, displayName: name };
      if (roles.length === 1 && !twoFactorSetupRequired) {
        const only = roles[0];
        const s = await startSession(req, reply, user.id, only.role, only.employeeId ?? null);
        return { ...base, accessToken: s.accessToken };
      }
      const preToken = await signAccessToken(app.cfg.JWT_SECRET, { sub: user.id, pre: true }, '10m');
      return { ...base, preToken, twoFactorSetupRequired };
    },
  );

  const selectBody = z.object({
    role: roleSchema,
    employeeId: z.coerce.number().int().positive().optional(),
  });

  async function selectRole(
    req: FastifyRequest,
    reply: FastifyReply,
    body: z.infer<typeof selectBody>,
    switching: boolean,
  ) {
    const userId = req.preUserId!;
    const { roles } = await loadAvailableRoles(app.db, userId);
    const match = roles.find(
      (x) => x.role === body.role && (body.role !== 'employee' || x.employeeId === body.employeeId),
    );
    if (!match) throw new AppError('FORBIDDEN_SCOPE', 'Role is not available for this account');
    if (body.role === 'superAdmin' || body.role === 'admin') {
      const u = await app.db
        .selectFrom('user_account')
        .select('totp_enabled')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      if (!u.totp_enabled)
        throw new AppError('FORBIDDEN_SCOPE', 'Two-factor setup required', { twoFactorSetupRequired: true });
    }
    if (switching) {
      const old = req.cookies[COOKIE];
      if (old)
        await app.db
          .updateTable('refresh_token')
          .set({ revoked_at: app.clock() })
          .where('token_hash', '=', sha256(old))
          .where('revoked_at', 'is', null)
          .execute();
    }
    const s = await startSession(req, reply, userId, body.role, match.employeeId ?? null);
    await audit(
      app.db,
      { userId, type: roleToActorType(body.role), ip: req.ip, userAgent: req.headers['user-agent'] },
      {
        action: switching ? 'switch_role' : 'select_role',
        entityType: 'user_account',
        entityId: userId,
        new: { role: body.role, employeeId: body.employeeId ?? null },
      },
    );
    return { accessToken: s.accessToken, role: s.role, employeeId: s.employeeId };
  }

  r.post(
    '/auth/select-role',
    { config: authLimit, preValidation: requirePreOrAccess, schema: { body: selectBody } },
    (req, reply) => selectRole(req, reply, req.body, false),
  );
  r.post(
    '/auth/switch-role',
    { preValidation: requireRole('ANY'), schema: { body: selectBody } },
    (req, reply) => {
      req.preUserId = getPrincipal(req).userId;
      return selectRole(req, reply, req.body, true);
    },
  );

  // ---- refresh / logout ---------------------------------------------------------------------
  r.post('/auth/refresh', { config: authLimit }, async (req, reply) => {
    const raw = req.cookies[COOKIE];
    if (!raw) throw new AppError('UNAUTHENTICATED', 'No refresh token');
    const row = await app.db
      .selectFrom('refresh_token')
      .selectAll()
      .where('token_hash', '=', sha256(raw))
      .executeTakeFirst();
    const now = app.clock();
    if (!row) throw new AppError('UNAUTHENTICATED', 'Invalid refresh token');
    if (row.revoked_at) {
      // reuse of a rotated token: revoke the whole family
      await app.db
        .updateTable('refresh_token')
        .set({ revoked_at: now })
        .where('user_id', '=', row.user_id)
        .where('revoked_at', 'is', null)
        .execute();
      throw new AppError('UNAUTHENTICATED', 'Refresh token was already used');
    }
    if (row.expires_at < now) throw new AppError('UNAUTHENTICATED', 'Refresh token expired');
    const u = await app.db
      .selectFrom('user_account')
      .select('status')
      .where('id', '=', row.user_id)
      .executeTakeFirst();
    if (!u || u.status !== 'active') throw new AppError('UNAUTHENTICATED', 'Account is not active');
    await app.db.updateTable('refresh_token').set({ revoked_at: now }).where('id', '=', row.id).execute();
    const s = await startSession(req, reply, row.user_id, row.active_role as Role, row.active_employee_id);
    return { accessToken: s.accessToken, role: s.role, employeeId: s.employeeId };
  });

  r.post('/auth/logout', async (req, reply) => {
    const raw = req.cookies[COOKIE];
    if (raw) {
      const row = await app.db
        .updateTable('refresh_token')
        .set({ revoked_at: app.clock() })
        .where('token_hash', '=', sha256(raw))
        .where('revoked_at', 'is', null)
        .returning('user_id')
        .executeTakeFirst();
      if (row)
        await audit(
          app.db,
          { userId: row.user_id, type: 'system', ip: req.ip },
          { action: 'logout', entityType: 'user_account', entityId: row.user_id },
        );
    }
    reply.clearCookie(COOKIE, { path: '/api/v1/auth' });
    return reply.status(204).send();
  });

  // ---- invitation, activation and password reset --------------------------------------------
  const acceptBody = z.union([
    z.object({ token: z.string().min(10).max(200), password: z.string().max(200) }),
    z.object({
      username: z.string().min(1).max(60),
      code: z.string().min(6).max(20),
      password: z.string().max(200),
    }),
  ]);
  r.post(
    '/auth/accept-invitation',
    { config: authLimit, schema: { body: acceptBody } },
    async (req, reply) => {
      const b = req.body;
      assertPasswordPolicy(b.password);
      const now = app.clock();
      let user;
      if ('token' in b) {
        user = await app.db
          .selectFrom('user_account')
          .selectAll()
          .where('invitation_token_hash', '=', sha256(b.token))
          .executeTakeFirst();
      } else {
        user = await app.db
          .selectFrom('user_account')
          .selectAll()
          .where((eb) => eb(eb.fn('lower', ['username']), '=', b.username.toLowerCase()))
          .where('invitation_token_hash', '=', sha256(b.code.trim().toUpperCase()))
          .executeTakeFirst();
      }
      if (
        !user ||
        !user.invitation_expires_at ||
        user.invitation_expires_at < now ||
        user.status === 'disabled'
      ) {
        throw new AppError('UNAUTHENTICATED', 'Invitation is invalid or expired');
      }
      const hash = await hashSecret(b.password);
      await app.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('user_account')
          .set({
            password_hash: hash,
            status: 'active',
            invitation_token_hash: null,
            invitation_expires_at: null,
            failed_login_count: 0,
            locked_until: null,
            updated_at: now,
          })
          .where('id', '=', user.id)
          .execute();
        await trx
          .updateTable('refresh_token')
          .set({ revoked_at: now })
          .where('user_id', '=', user.id)
          .where('revoked_at', 'is', null)
          .execute();
        await audit(
          trx,
          { userId: user.id, type: 'system', ip: req.ip, userAgent: req.headers['user-agent'] },
          {
            action: user.status === 'pending_invite' ? 'account_activated' : 'password_reset',
            entityType: 'user_account',
            entityId: user.id,
          },
        );
      });
      return reply.status(200).send({ status: 'ok' });
    },
  );

  r.post(
    '/auth/forgot-password',
    { config: authLimit, schema: { body: z.object({ email: z.string().min(1).max(255) }) } },
    async (req, reply) => {
      const now = app.clock();
      const ident = req.body.email.toLowerCase();
      const user = await app.db
        .selectFrom('user_account')
        .select(['id', 'email', 'status'])
        .where((eb) =>
          eb.or([eb(eb.fn('lower', ['email']), '=', ident), eb(eb.fn('lower', ['username']), '=', ident)]),
        )
        .executeTakeFirst();
      if (user && user.email && user.status !== 'disabled') {
        const token = randomToken();
        await app.db.transaction().execute(async (trx) => {
          await trx
            .updateTable('user_account')
            .set({
              invitation_token_hash: sha256(token),
              invitation_expires_at: new Date(now.getTime() + 3600e3),
            })
            .where('id', '=', user.id)
            .execute();
          await audit(
            trx,
            { userId: user.id, type: 'system', ip: req.ip },
            { action: 'password_reset_requested', entityType: 'user_account', entityId: user.id },
          );
        });
        await app.mailer.send(
          resetMail(user.email, `${app.cfg.WEB_ORIGIN}/accept-invitation?token=${token}`),
        );
      }
      return reply.status(204).send();
    },
  );

  // ---- TOTP ---------------------------------------------------------------------------------
  async function twoFactorUser(req: FastifyRequest) {
    const userId = req.principal?.userId ?? req.preUserId!;
    const { roles } = await loadAvailableRoles(app.db, userId);
    if (!isStaffAdmin(roles)) throw new AppError('FORBIDDEN_SCOPE', 'Two-factor is only for admin roles');
    const u = await app.db
      .selectFrom('user_account')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    return { u, roles };
  }

  r.post('/auth/2fa/setup', { config: authLimit, preValidation: requirePreOrAccess }, async (req) => {
    const { u } = await twoFactorUser(req);
    if (u.totp_enabled) throw new AppError('CONFLICT', 'Two-factor is already enabled');
    const secret = authenticator.generateSecret();
    await app.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('user_account')
        .set({ totp_secret_enc: encryptSecret(secret, app.cfg.TOTP_ENC_KEY) })
        .where('id', '=', u.id)
        .execute();
      await audit(trx, actorOf(req), {
        action: 'totp_setup_started',
        entityType: 'user_account',
        entityId: u.id,
      });
    });
    const otpauthUrl = authenticator.keyuri(
      u.email ?? u.username ?? `user${u.id}`,
      'Trip Inn Dienstplan',
      secret,
    );
    return { secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl) };
  });

  r.post(
    '/auth/2fa/verify',
    {
      config: authLimit,
      preValidation: requirePreOrAccess,
      schema: { body: z.object({ code: z.string().min(6).max(8) }) },
    },
    async (req) => {
      const { u } = await twoFactorUser(req);
      if (!u.totp_secret_enc) throw new AppError('CONFLICT', 'Call /auth/2fa/setup first');
      const secret = decryptSecret(u.totp_secret_enc as Buffer, app.cfg.TOTP_ENC_KEY);
      if (!authenticator.check(req.body.code, secret))
        throw new AppError('UNAUTHENTICATED', 'Invalid authentication code');
      await app.db.transaction().execute(async (trx) => {
        await trx.updateTable('user_account').set({ totp_enabled: true }).where('id', '=', u.id).execute();
        await audit(trx, actorOf(req), {
          action: 'totp_enabled',
          entityType: 'user_account',
          entityId: u.id,
        });
      });
      return { enabled: true };
    },
  );
}
