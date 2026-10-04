import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { createDb, type Db } from '../src/db';
import { authenticator } from 'otplib';
import { encryptSecret, hashSecret } from '../src/lib/security';
import { loadConfig } from '../src/config';

const TOTP_SECRETS = new Map<string, string>();

/** Enables TOTP for the account (admins need it before they can pick a role). */
export async function enableTotp(db: Db, userId: number): Promise<string> {
  const secret = authenticator.generateSecret();
  await db
    .updateTable('user_account')
    .set({ totp_enabled: true, totp_secret_enc: encryptSecret(secret, loadConfig().TOTP_ENC_KEY) })
    .where('id', '=', userId)
    .execute();
  const u = await db
    .selectFrom('user_account')
    .select(['email', 'username'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  TOTP_SECRETS.set((u.email ?? u.username)!.toLowerCase(), secret);
  return secret;
}

export const TEST_PASSWORD = 'Passw0rd!23';

export interface TestCtx {
  app: FastifyInstance;
  db: Db;
  now: { value: Date };
  logs: string[];
}

export async function startApp(opts: { now?: Date; rateLimit?: number } = {}): Promise<TestCtx> {
  const db = createDb(process.env.DATABASE_URL!);
  await resetDb(db);
  const now = { value: opts.now ?? new Date('2026-10-04T10:00:00Z') };
  const logs: string[] = [];
  const app = await buildApp({
    db,
    clock: () => new Date(now.value),
    config: {
      DATABASE_URL: process.env.DATABASE_URL,
      MAIL_MODE: 'json',
      RATE_LIMIT_AUTH: opts.rateLimit ?? 100000,
      RATE_LIMIT_KIOSK: opts.rateLimit ?? 100000,
      LOG_LEVEL: 'info',
    },
    logger: {
      level: 'info',
      stream: { write: (m: string) => void logs.push(m) },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-kiosk-token"]',
          '*.pin',
          '*.password',
          '*.token',
          '*.code',
          '*.totp',
        ],
        censor: '[redacted]',
      },
    },
  });
  return { app, db, now, logs };
}

export async function stopApp(ctx: TestCtx) {
  await ctx.app.close();
  await ctx.db.destroy().catch(() => undefined);
}

export async function resetDb(db: Db) {
  const rows = await sql<{
    tablename: string;
  }>`select tablename from pg_tables where schemaname='public' and tablename not in ('schema_migrations','absence_type')`.execute(
    db,
  );
  const list = rows.rows.map((r) => `"${r.tablename}"`).join(', ');
  await sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`).execute(db);
}

export async function makeUser(
  db: Db,
  p: { email?: string | null; username?: string | null; password?: string | null; status?: string },
) {
  const hash = p.password === null ? null : await hashSecret(p.password ?? TEST_PASSWORD);
  return db
    .insertInto('user_account')
    .values({
      email: p.email ?? null,
      username: p.username ?? null,
      password_hash: hash,
      status: p.status ?? 'active',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
    .then((r) => r.id);
}

export async function makeSuperAdmin(db: Db, email = 'sa@test.dev') {
  const userId = await makeUser(db, { email });
  await enableTotp(db, userId);
  const sa = await db
    .insertInto('super_admin')
    .values({ user_id: userId, first_name: 'Sam', last_name: 'Super' })
    .returning('super_admin_id')
    .executeTakeFirstOrThrow();
  return { userId, superAdminId: sa.super_admin_id };
}

export async function loginAs(
  ctx: TestCtx,
  login: string,
  role: 'superAdmin' | 'admin' | 'manager' | 'employee',
  opts: { employeeId?: number; password?: string; totp?: string } = {},
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: {
      login,
      password: opts.password ?? TEST_PASSWORD,
      totp:
        opts.totp ??
        (TOTP_SECRETS.has(login.toLowerCase())
          ? authenticator.generate(TOTP_SECRETS.get(login.toLowerCase())!)
          : undefined),
    },
  });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  const body = res.json();
  if (body.accessToken) return body.accessToken;
  const sel = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/select-role',
    headers: { authorization: `Bearer ${body.preToken}` },
    payload: { role, employeeId: opts.employeeId },
  });
  if (sel.statusCode !== 200) throw new Error(`select-role failed ${sel.statusCode} ${sel.body}`);
  return sel.json().accessToken;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });
