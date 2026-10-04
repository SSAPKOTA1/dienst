import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { sha256 } from '../src/lib/security';
import {
  auth,
  enableTotp,
  loginAs,
  makeSuperAdmin,
  makeUser,
  startApp,
  stopApp,
  TEST_PASSWORD,
  type TestCtx,
} from './helpers';

let ctx: TestCtx;
let saUser: number;
let companyId: number;
let hotelId: number;
beforeAll(async () => {
  ctx = await startApp();
  const sa = await makeSuperAdmin(ctx.db);
  saUser = sa.userId;
  const c = await ctx.db
    .insertInto('company')
    .values({ name: 'Test Co', created_by_id: sa.superAdminId })
    .returning('id')
    .executeTakeFirstOrThrow();
  companyId = c.id;
  const h = await ctx.db
    .insertInto('hotel')
    .values({ company_id: companyId, name: 'H1', federal_state: 'HE' })
    .returning('id')
    .executeTakeFirstOrThrow();
  hotelId = h.id;
});
afterAll(async () => stopApp(ctx));

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload: payload as object, headers });

describe('login', () => {
  it('admins need TOTP once enabled, and pick a role after login', async () => {
    const noTotp = await post('/auth/login', { login: 'sa@test.dev', password: TEST_PASSWORD });
    expect(noTotp.statusCode).toBe(401);
    expect(noTotp.json().error.details.totpRequired).toBe(true);
    const token = await loginAs(ctx, 'sa@test.dev', 'superAdmin');
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(token) });
    expect(me.json().role).toBe('superAdmin');
  });

  it('wrong password -> 401 and lock after 5 failures', async () => {
    const id = await makeUser(ctx.db, { username: 'lock.me' });
    await mkEmployee(id, 'Lock', 'Me');
    for (let i = 0; i < 5; i++) {
      const r = await post('/auth/login', { login: 'lock.me', password: 'wrong-password' });
      expect(r.statusCode).toBe(401);
    }
    const locked = await post('/auth/login', { login: 'lock.me', password: TEST_PASSWORD });
    expect(locked.statusCode).toBe(401);
    ctx.now.value = new Date(ctx.now.value.getTime() + 16 * 60e3);
    const after = await post('/auth/login', { login: 'lock.me', password: TEST_PASSWORD });
    expect(after.statusCode).toBe(200);
    ctx.now.value = new Date(ctx.now.value.getTime() - 16 * 60e3);
  });

  it('login works with e-mail and with username, case-insensitive', async () => {
    const userId = await makeUser(ctx.db, { email: 'Emp.One@Test.dev', username: 'emp.one' });
    const emp = await mkEmployee(userId, 'Emp', 'One');
    const a = await post('/auth/login', { login: 'emp.one@test.DEV', password: TEST_PASSWORD });
    const b = await post('/auth/login', { login: 'EMP.ONE', password: TEST_PASSWORD });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().accessToken).toBeTruthy(); // single role -> token directly
    expect(a.json().availableRoles).toEqual([{ role: 'employee', employeeId: emp, companyName: 'Test Co' }]);
    expect(a.cookies.find((c) => c.name === 'rt')?.httpOnly).toBe(true);
  });

  it('records last_login_at and writes audit rows', async () => {
    const u = await ctx.db
      .selectFrom('user_account')
      .select('last_login_at')
      .where('username', '=', 'emp.one')
      .executeTakeFirstOrThrow();
    expect(u.last_login_at).not.toBeNull();
    const rows = await ctx.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', 'in', ['login', 'login_failed'])
      .execute();
    expect(rows.some((r) => r.action === 'login')).toBe(true);
    expect(rows.some((r) => r.action === 'login_failed')).toBe(true);
  });

  it('pending accounts cannot log in', async () => {
    await makeUser(ctx.db, { username: 'pending.one', password: null, status: 'pending_invite' });
    const r = await post('/auth/login', { login: 'pending.one', password: TEST_PASSWORD });
    expect(r.statusCode).toBe(401);
  });
});

async function mkEmployee(userId: number, first: string, last: string): Promise<number> {
  const admin = await ensureAdmin();
  const dep = await ctx.db
    .insertInto('department')
    .values({ hotel_id: hotelId, name: `D${userId}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  const e = await ctx.db
    .insertInto('employee')
    .values({
      user_id: userId,
      company_id: companyId,
      primary_hotel_id: hotelId,
      primary_department_id: dep.id,
      personnel_number: `P${100 + userId}`,
      first_name: first,
      last_name: last,
      date_of_birth: '1990-01-01',
      pin_hash: 'x',
      contract_start_date: '2026-01-01',
      created_by_id: admin,
    })
    .returning('employee_id')
    .executeTakeFirstOrThrow();
  return e.employee_id;
}
let adminRowId = 0;
async function ensureAdmin(): Promise<number> {
  if (adminRowId) return adminRowId;
  const uid = await makeUser(ctx.db, { email: 'admin@test.dev' });
  const sa = await ctx.db.selectFrom('super_admin').select('super_admin_id').executeTakeFirstOrThrow();
  const a = await ctx.db
    .insertInto('admin')
    .values({ user_id: uid, first_name: 'Ada', last_name: 'Admin', created_by_id: sa.super_admin_id })
    .returning('admin_id')
    .executeTakeFirstOrThrow();
  await ctx.db
    .insertInto('admin_company')
    .values({ admin_id: a.admin_id, company_id: companyId, assigned_by_id: sa.super_admin_id })
    .execute();
  await enableTotp(ctx.db, uid);
  adminRowId = a.admin_id;
  return adminRowId;
}

describe('role selection', () => {
  it('multi-role user gets a pre token, selects a role and can switch', async () => {
    const uid = await makeUser(ctx.db, { email: 'multi@test.dev' });
    const e1 = await mkEmployee(uid, 'Multi', 'Role');
    const sa = await ctx.db.selectFrom('super_admin').select('super_admin_id').executeTakeFirstOrThrow();
    const m = await ctx.db
      .insertInto('manager')
      .values({ user_id: uid, first_name: 'Multi', last_name: 'Role', created_by_id: await ensureAdmin() })
      .returning('manager_id')
      .executeTakeFirstOrThrow();
    await ctx.db
      .insertInto('manager_hotel')
      .values({ manager_id: m.manager_id, hotel_id: hotelId })
      .execute();
    void sa;
    const login = await post('/auth/login', { login: 'multi@test.dev', password: TEST_PASSWORD });
    const body = login.json();
    expect(body.accessToken).toBeUndefined();
    expect(body.availableRoles.map((r: any) => r.role).sort()).toEqual(['employee', 'manager']);
    // pre token cannot call protected endpoints
    const denied = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(body.preToken) });
    expect(denied.statusCode).toBe(401);
    const sel = await post('/auth/select-role', { role: 'manager' }, auth(body.preToken));
    expect(sel.statusCode).toBe(200);
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: auth(sel.json().accessToken),
    });
    expect(me.json().role).toBe('manager');
    expect(me.json().hotelIds).toEqual([hotelId]);
    // cannot pick someone else's employee row or a role the user does not have
    expect(
      (await post('/auth/select-role', { role: 'employee', employeeId: e1 + 99 }, auth(body.preToken)))
        .statusCode,
    ).toBe(403);
    expect((await post('/auth/select-role', { role: 'superAdmin' }, auth(body.preToken))).statusCode).toBe(
      403,
    );
    const sw = await post(
      '/auth/switch-role',
      { role: 'employee', employeeId: e1 },
      { ...auth(sel.json().accessToken), cookie: `rt=${sel.cookies[0].value}` },
    );
    expect(sw.statusCode).toBe(200);
    const me2 = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: auth(sw.json().accessToken),
    });
    expect(me2.json().role).toBe('employee');
    expect(me2.json().employeeId).toBe(e1);
  });

  it('manager token is refused on an admin-only endpoint', async () => {
    const t = await loginAs(ctx, 'multi@test.dev', 'manager');
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/switch-role',
      headers: auth(t),
      payload: { role: 'admin' },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('refresh tokens rotate', () => {
  it('rotates, rejects reuse and logout revokes', async () => {
    const login = await post('/auth/login', { login: 'emp.one', password: TEST_PASSWORD });
    const rt1 = login.cookies.find((c) => c.name === 'rt')!.value;
    const r1 = await post('/auth/refresh', {}, { cookie: `rt=${rt1}` });
    expect(r1.statusCode).toBe(200);
    const rt2 = r1.cookies.find((c) => c.name === 'rt')!.value;
    expect(rt2).not.toBe(rt1);
    const reuse = await post('/auth/refresh', {}, { cookie: `rt=${rt1}` });
    expect(reuse.statusCode).toBe(401);
    // reuse revoked the family
    const r2 = await post('/auth/refresh', {}, { cookie: `rt=${rt2}` });
    expect(r2.statusCode).toBe(401);
    const login2 = await post('/auth/login', { login: 'emp.one', password: TEST_PASSWORD });
    const rt3 = login2.cookies.find((c) => c.name === 'rt')!.value;
    expect((await post('/auth/logout', {}, { cookie: `rt=${rt3}` })).statusCode).toBe(204);
    expect((await post('/auth/refresh', {}, { cookie: `rt=${rt3}` })).statusCode).toBe(401);
  });
});

describe('invitation, activation and reset', () => {
  it('activates by mailed link token (24 h) and the token is single use', async () => {
    const uid = await makeUser(ctx.db, { email: 'inv@test.dev', password: null, status: 'pending_invite' });
    await mkEmployee(uid, 'Inv', 'Ited');
    const token = 'tok_' + 'a'.repeat(40);
    await ctx.db
      .updateTable('user_account')
      .set({
        invitation_token_hash: sha256(token),
        invitation_expires_at: new Date(ctx.now.value.getTime() + 24 * 3600e3),
      })
      .where('id', '=', uid)
      .execute();
    expect((await post('/auth/accept-invitation', { token, password: 'short' })).statusCode).toBe(400);
    expect((await post('/auth/accept-invitation', { token, password: 'a-long-enough-pw' })).statusCode).toBe(
      200,
    );
    expect((await post('/auth/accept-invitation', { token, password: 'another-long-pw1' })).statusCode).toBe(
      401,
    );
    const l = await post('/auth/login', { login: 'inv@test.dev', password: 'a-long-enough-pw' });
    expect(l.statusCode).toBe(200);
  });

  it('activates by username + printed code; code expires after 7 days', async () => {
    const uid = await makeUser(ctx.db, { username: 'code.user', password: null, status: 'pending_invite' });
    await mkEmployee(uid, 'Code', 'User');
    await ctx.db
      .updateTable('user_account')
      .set({
        invitation_token_hash: sha256('ABCDEFGH23'),
        invitation_expires_at: new Date(ctx.now.value.getTime() + 7 * 86400e3),
      })
      .where('id', '=', uid)
      .execute();
    expect(
      (
        await post('/auth/accept-invitation', {
          username: 'code.user',
          code: 'WRONGCODE2',
          password: 'a-long-enough-pw',
        })
      ).statusCode,
    ).toBe(401);
    ctx.now.value = new Date(ctx.now.value.getTime() + 8 * 86400e3);
    expect(
      (
        await post('/auth/accept-invitation', {
          username: 'code.user',
          code: 'ABCDEFGH23',
          password: 'a-long-enough-pw',
        })
      ).statusCode,
    ).toBe(401);
    ctx.now.value = new Date(ctx.now.value.getTime() - 8 * 86400e3);
    expect(
      (
        await post('/auth/accept-invitation', {
          username: 'CODE.user',
          code: 'abcdefgh23',
          password: 'a-long-enough-pw',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await post('/auth/accept-invitation', {
          username: 'code.user',
          code: 'ABCDEFGH23',
          password: 'a-long-enough-pw',
        })
      ).statusCode,
    ).toBe(401);
  });

  it('forgot-password always answers 204, mails a token only for known accounts, without secrets in logs', async () => {
    ctx.app.mailer.outbox.length = 0;
    expect((await post('/auth/forgot-password', { email: 'nobody@test.dev' })).statusCode).toBe(204);
    expect(ctx.app.mailer.outbox).toHaveLength(0);
    expect((await post('/auth/forgot-password', { email: 'inv@test.dev' })).statusCode).toBe(204);
    expect(ctx.app.mailer.outbox).toHaveLength(1);
    const link = ctx.app.mailer.outbox[0].text.match(/token=([\w-]+)/)![1];
    expect(
      (await post('/auth/accept-invitation', { token: link, password: 'brand-new-password' })).statusCode,
    ).toBe(200);
    expect(
      (await post('/auth/login', { login: 'inv@test.dev', password: 'brand-new-password' })).statusCode,
    ).toBe(200);
    expect(ctx.logs.join('\n')).not.toContain(link);
  });
});

describe('two-factor', () => {
  it('admin without TOTP must set it up before selecting a role', async () => {
    const uid = await makeUser(ctx.db, { email: 'newadmin@test.dev' });
    const sa = await ctx.db.selectFrom('super_admin').select('super_admin_id').executeTakeFirstOrThrow();
    await ctx.db
      .insertInto('admin')
      .values({ user_id: uid, first_name: 'N', last_name: 'A', created_by_id: sa.super_admin_id })
      .execute();
    const login = await post('/auth/login', { login: 'newadmin@test.dev', password: TEST_PASSWORD });
    const b = login.json();
    expect(b.twoFactorSetupRequired).toBe(true);
    expect(b.accessToken).toBeUndefined();
    const denied = await post('/auth/select-role', { role: 'admin' }, auth(b.preToken));
    expect(denied.statusCode).toBe(403);
    const setup = await post('/auth/2fa/setup', {}, auth(b.preToken));
    expect(setup.statusCode).toBe(200);
    const { secret, qrDataUrl } = setup.json();
    expect(qrDataUrl.startsWith('data:image/png')).toBe(true);
    expect((await post('/auth/2fa/verify', { code: '000000' }, auth(b.preToken))).statusCode).toBe(401);
    expect(
      (await post('/auth/2fa/verify', { code: authenticator.generate(secret) }, auth(b.preToken))).statusCode,
    ).toBe(200);
    expect((await post('/auth/select-role', { role: 'admin' }, auth(b.preToken))).statusCode).toBe(200);
    // next login requires the code
    expect(
      (await post('/auth/login', { login: 'newadmin@test.dev', password: TEST_PASSWORD })).statusCode,
    ).toBe(401);
    expect(saUser).toBeGreaterThan(0);
  });
});

describe('rate limits', () => {
  it('auth endpoints are limited per IP', async () => {
    const c2 = await startApp({ rateLimit: 3 });
    for (let i = 0; i < 3; i++) {
      const r = await c2.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { login: 'x', password: 'y' },
      });
      expect(r.statusCode).toBe(401);
    }
    const r = await c2.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'x', password: 'y' },
    });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('RATE_LIMITED');
    await stopApp(c2);
  });
});
