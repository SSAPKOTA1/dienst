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
      RATE_LIMIT_GLOBAL: opts.rateLimit ?? 100000,
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

export interface Org {
  saToken: string;
  adminA: { token: string; userId: number; adminId: number };
  adminB: { token: string; userId: number; adminId: number };
  mgrA1: { token: string; userId: number; managerId: number };
  mgrA2: { token: string; userId: number; managerId: number };
  superAdminId: number;
  companyA: number;
  companyB: number;
  hotelA1: number;
  hotelA2: number;
  hotelB1: number;
  deptA1: number; // Rezeption at A1
  deptA1b: number; // Housekeeping at A1
  deptA2: number;
  deptB1: number;
}

/** Two companies, three hotels, admins for each company, managers for A1 and A2. Built by direct inserts. */
export async function setupOrg(ctx: TestCtx): Promise<Org> {
  const { db } = ctx;
  const sa = await makeSuperAdmin(db);
  const mk = async (name: string) =>
    (
      await db
        .insertInto('company')
        .values({ name, created_by_id: sa.superAdminId })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const companyA = await mk('Company A');
  const companyB = await mk('Company B');
  const hotel = async (companyId: number, name: string, state: string) =>
    (
      await db
        .insertInto('hotel')
        .values({ company_id: companyId, name, federal_state: state })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const hotelA1 = await hotel(companyA, 'A1 Frankfurt', 'HE');
  const hotelA2 = await hotel(companyA, 'A2 Berlin', 'BE');
  const hotelB1 = await hotel(companyB, 'B1 Hamburg', 'HH');
  const dept = async (hotelId: number, name: string) =>
    (
      await db
        .insertInto('department')
        .values({ hotel_id: hotelId, name })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const deptA1 = await dept(hotelA1, 'Rezeption');
  const deptA1b = await dept(hotelA1, 'Housekeeping');
  const deptA2 = await dept(hotelA2, 'Rezeption');
  const deptB1 = await dept(hotelB1, 'Rezeption');
  const mkAdmin = async (email: string, companyId: number) => {
    const userId = await makeUser(db, { email });
    await enableTotp(db, userId);
    const a = await db
      .insertInto('admin')
      .values({
        user_id: userId,
        first_name: 'Admin',
        last_name: email.slice(0, 1).toUpperCase(),
        created_by_id: sa.superAdminId,
      })
      .returning('admin_id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('admin_company')
      .values({ admin_id: a.admin_id, company_id: companyId, assigned_by_id: sa.superAdminId })
      .execute();
    return { userId, adminId: a.admin_id };
  };
  const mkMgr = async (email: string, hotelId: number, adminId: number) => {
    const userId = await makeUser(db, { email });
    const m = await db
      .insertInto('manager')
      .values({
        user_id: userId,
        first_name: 'Mgr',
        last_name: email.slice(0, 1).toUpperCase(),
        created_by_id: adminId,
      })
      .returning('manager_id')
      .executeTakeFirstOrThrow();
    await db.insertInto('manager_hotel').values({ manager_id: m.manager_id, hotel_id: hotelId }).execute();
    return { userId, managerId: m.manager_id };
  };
  const a = await mkAdmin('admin.a@test.dev', companyA);
  const b = await mkAdmin('admin.b@test.dev', companyB);
  const m1 = await mkMgr('mgr.a1@test.dev', hotelA1, a.adminId);
  const m2 = await mkMgr('mgr.a2@test.dev', hotelA2, a.adminId);
  return {
    superAdminId: sa.superAdminId,
    saToken: await loginAs(ctx, 'sa@test.dev', 'superAdmin'),
    adminA: { ...a, token: await loginAs(ctx, 'admin.a@test.dev', 'admin') },
    adminB: { ...b, token: await loginAs(ctx, 'admin.b@test.dev', 'admin') },
    mgrA1: { ...m1, token: await loginAs(ctx, 'mgr.a1@test.dev', 'manager') },
    mgrA2: { ...m2, token: await loginAs(ctx, 'mgr.a2@test.dev', 'manager') },
    companyA,
    companyB,
    hotelA1,
    hotelA2,
    hotelB1,
    deptA1,
    deptA1b,
    deptA2,
    deptB1,
  };
}

export const empBody = (org: Org, over: Record<string, unknown> = {}) => ({
  firstName: 'Maria',
  lastName: 'Schmidt',
  dateOfBirth: '1990-05-12',
  email: null,
  primaryHotelId: org.hotelA1,
  primaryDepartmentId: org.deptA1,
  contractStartDate: '2026-01-01',
  employmentType: 'full_time',
  workingModel: 'salary',
  workDaysPerWeek: 5,
  targetHoursPerWeek: 40,
  vacationDaysPerYear: 30,
  ...over,
});

export async function call(
  ctx: TestCtx,
  method: string,
  url: string,
  token: string | null,
  payload?: unknown,
) {
  const res = await ctx.app.inject({
    method: method as any,
    url: `/api/v1${url}`,
    headers: token ? auth(token) : {},
    payload: payload as object | undefined,
  });
  let body: any = null;
  try {
    body = res.json();
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, res };
}

// ---------------------------------------------------------------------------------------------
// planning fixture

export interface PlanFx extends Org {
  early: number; // Rezeption A1 06:00-14:00
  late: number; // 14:00-22:00
  night: number; // 22:00-06:00
  hk: number; // Housekeeping A1 08:00-16:30
  early2: number; // Rezeption A2 06:00-14:00
  emp: Record<string, number>;
  pin: Record<string, string>;
}

export async function planFixture(ctx: TestCtx): Promise<PlanFx> {
  const org = await setupOrg(ctx);
  const shift = async (
    hotelId: number,
    departmentId: number,
    name: string,
    startTime: string,
    endTime: string,
    breakMinutes = 30,
  ) =>
    (
      await call(ctx, 'POST', '/shifts', org.adminA.token, {
        hotelId,
        departmentId,
        name,
        startTime,
        endTime,
        breakMinutes,
      })
    ).body.id as number;
  const early = await shift(org.hotelA1, org.deptA1, 'Früh', '06:00', '14:00');
  const late = await shift(org.hotelA1, org.deptA1, 'Spät', '14:00', '22:00');
  const night = await shift(org.hotelA1, org.deptA1, 'Nacht', '22:00', '06:00');
  const hk = await shift(org.hotelA1, org.deptA1b, 'Tag', '08:00', '16:30');
  const early2 = await shift(org.hotelA2, org.deptA2, 'Früh', '06:00', '14:00');
  const mk = async (key: string, over: Record<string, unknown> = {}) => {
    const r = await call(
      ctx,
      'POST',
      '/employees',
      org.adminA.token,
      empBody(org, { firstName: key, lastName: 'Test', ...over }),
    );
    if (r.status !== 201) throw new Error(`employee ${key}: ${JSON.stringify(r.body)}`);
    pins[key.toLowerCase()] = r.body.pin;
    return r.body.employeeId as number;
  };
  const pins: Record<string, string> = {};
  const emp: Record<string, number> = {
    maria: await mk('Maria'),
    jon: await mk('Jon'),
    lena: await mk('Lena', { dateOfBirth: '2009-02-14', employmentType: 'apprentice' }),
    tom: await mk('Tom', { hotelIds: [org.hotelA2], departmentIds: [org.deptA2] }), // A1 + A2
    piotr: await mk('Piotr', { primaryDepartmentId: org.deptA1b }), // housekeeping only
    cap: await mk('Cap', { monthlyHoursCap: 20, workingModel: 'hourly', targetHoursPerWeek: 10 }),
  };
  return { ...org, early, late, night, hk, early2, emp, pin: pins };
}

export const plan = (fx: PlanFx, token: string, body: Record<string, unknown>) =>
  call(ctxHolder.ctx!, 'POST', '/schedule/entries', token, { hotelId: fx.hotelA1, ...body });
export const ctxHolder: { ctx: TestCtx | null } = { ctx: null };
