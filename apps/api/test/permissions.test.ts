import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../src/lib/security';
import { call, empBody, loginAs, setupOrg, startApp, stopApp, type Org, type TestCtx } from './helpers';

/**
 * Table-driven permission matrix (SPEC 2.2 / 8). Each row: endpoint x role -> allowed (not 401/403) or denied (403).
 * "allowed" only asserts that the role passes the role/scope gate, so bodies may be invalid (400/404 are fine).
 */
let ctx: TestCtx;
// placeholder values let the table build titles before the fixtures exist
let org: Org = new Proxy({}, { get: () => 0 }) as Org;
let empId = 0;
let empToken: string;
beforeAll(async () => {
  ctx = await startApp();
  org = await setupOrg(ctx);
  const r = await call(ctx, 'POST', '/employees', org.adminA.token, empBody(org, { email: 'perm@test.dev' }));
  empId = r.body.employeeId;
  await ctx.db.updateTable('user_account').set({ password_hash: await hashSecret('Passw0rd!23'), status: 'active' }).where('id', '=', r.body.userId).execute();
  empToken = await loginAs(ctx, 'perm@test.dev', 'employee', { employeeId: empId });
});
afterAll(async () => stopApp(ctx));

type Role = 'SA' | 'AD' | 'MG' | 'EM' | 'ANON';
interface Row {
  method: string;
  url: () => string;
  body?: () => unknown;
  allow: Role[];
}

const rows: Row[] = [
  { method: 'POST', url: () => '/companies', body: () => ({ name: 'N' }), allow: ['SA'] },
  { method: 'GET', url: () => '/companies', allow: ['SA', 'AD'] },
  { method: 'POST', url: () => '/hotels', body: () => ({ companyId: org.companyA, name: 'Zed' }), allow: ['SA'] },
  { method: 'GET', url: () => '/hotels', allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => `/hotels/${org.hotelA1}/settings`, allow: ['SA', 'AD', 'MG'] },
  { method: 'PUT', url: () => `/hotels/${org.hotelA1}/settings`, body: () => ({ employeeHoursVisibility: 'after_approval' }), allow: ['SA', 'AD'] },
  { method: 'POST', url: () => '/admins', body: () => ({}), allow: ['SA'] },
  { method: 'GET', url: () => '/admins', allow: ['SA'] },
  { method: 'POST', url: () => '/managers', body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/managers', allow: ['SA', 'AD'] },
  { method: 'POST', url: () => '/departments', body: () => ({ hotelId: org.hotelA1, name: 'Perm' }), allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/departments', allow: ['SA', 'AD', 'MG'] },
  { method: 'POST', url: () => '/kiosk-devices', body: () => ({ hotelId: org.hotelA1, name: 'T' }), allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/kiosk-devices', allow: ['SA', 'AD'] },
  { method: 'GET', url: () => `/holidays?hotelId=${org.hotelA1}&year=2026`, allow: ['SA', 'AD', 'MG', 'EM'] },
  { method: 'POST', url: () => '/holidays', body: () => ({ scope: 'hotel', hotelId: org.hotelA1, date: '2026-05-05', name: 'x' }), allow: ['SA', 'AD'] },
  { method: 'POST', url: () => '/employees', body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/employees', allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => `/employees/${empId}`, allow: ['SA', 'AD', 'MG'] },
  { method: 'PUT', url: () => `/employees/${empId}`, body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'GET', url: () => `/employees/${empId}/contracts`, allow: ['SA', 'AD'] },
  { method: 'POST', url: () => `/employees/${empId}/reset-pin`, allow: ['SA', 'AD'] },
  { method: 'POST', url: () => `/employees/${empId}/unlock-pin`, allow: ['SA', 'AD'] },
  { method: 'POST', url: () => `/employees/${empId}/reset-activation`, allow: ['SA', 'AD'] },
  { method: 'GET', url: () => `/employees/${empId}/time-account`, allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => '/users', allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/setup/status', allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/setup/overview', allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/me', allow: ['SA', 'AD', 'MG', 'EM'] },
];

const tokenFor = (r: Role): string | null =>
  r === 'SA' ? org.saToken : r === 'AD' ? org.adminA.token : r === 'MG' ? org.mgrA1.token : r === 'EM' ? empToken : null;

describe('permission matrix', () => {
  for (const row of rows) {
    for (const role of ['SA', 'AD', 'MG', 'EM', 'ANON'] as Role[]) {
      const allowed = row.allow.includes(role);
      it(`${row.method} ${row.url().replace(/\d+/g, ':n')} as ${role} -> ${allowed ? 'allowed' : role === 'ANON' ? '401' : '403'}`, async () => {
        const r = await call(ctx, row.method, row.url(), tokenFor(role), row.body?.());
        if (role === 'ANON') expect(r.status).toBe(401);
        else if (allowed) expect([401, 403]).not.toContain(r.status);
        else expect(r.status).toBe(403);
      });
    }
  }
});
