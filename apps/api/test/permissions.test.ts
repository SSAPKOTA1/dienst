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
  await ctx.db
    .updateTable('user_account')
    .set({ password_hash: await hashSecret('Passw0rd!23'), status: 'active' })
    .where('id', '=', r.body.userId)
    .execute();
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
  {
    method: 'POST',
    url: () => '/hotels',
    body: () => ({ companyId: org.companyA, name: 'Zed' }),
    allow: ['SA'],
  },
  { method: 'GET', url: () => '/hotels', allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => `/hotels/${org.hotelA1}/settings`, allow: ['SA', 'AD', 'MG'] },
  {
    method: 'PUT',
    url: () => `/hotels/${org.hotelA1}/settings`,
    body: () => ({ employeeHoursVisibility: 'after_approval' }),
    allow: ['SA', 'AD'],
  },
  { method: 'POST', url: () => '/admins', body: () => ({}), allow: ['SA'] },
  { method: 'GET', url: () => '/admins', allow: ['SA'] },
  { method: 'POST', url: () => '/super-admins', body: () => ({}), allow: ['SA'] },
  {
    method: 'PUT',
    url: () => '/admins/1/access',
    body: () => ({ companyIds: [], hotelIds: [] }),
    allow: ['SA'],
  },
  {
    method: 'PUT',
    url: () => `/hotels/${org.hotelA1}/active`,
    body: () => ({ active: true }),
    allow: ['SA'],
  },
  { method: 'GET', url: () => '/users/1/roles', allow: ['SA'] },
  { method: 'PUT', url: () => '/users/1/roles', body: () => ({}), allow: ['SA'] },
  { method: 'POST', url: () => '/managers', body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/managers', allow: ['SA', 'AD'] },
  {
    method: 'POST',
    url: () => '/departments',
    body: () => ({ hotelId: org.hotelA1, name: 'Perm' }),
    allow: ['SA', 'AD'],
  },
  { method: 'GET', url: () => '/departments', allow: ['SA', 'AD', 'MG'] },
  {
    method: 'POST',
    url: () => '/kiosk-devices',
    body: () => ({ hotelId: org.hotelA1, name: 'T' }),
    allow: ['SA', 'AD'],
  },
  { method: 'GET', url: () => '/kiosk-devices', allow: ['SA', 'AD'] },
  { method: 'GET', url: () => `/holidays?hotelId=${org.hotelA1}&year=2026`, allow: ['SA', 'AD', 'MG', 'EM'] },
  {
    method: 'POST',
    url: () => '/holidays',
    body: () => ({ scope: 'hotel', hotelId: org.hotelA1, date: '2026-05-05', name: 'x' }),
    allow: ['SA', 'AD'],
  },
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
  { method: 'GET', url: () => `/live?hotelIds=${org.hotelA1}`, allow: ['SA', 'AD', 'MG'] },
  {
    method: 'POST',
    url: () => '/live/close-open',
    body: () => ({
      punchRecordId: 999999,
      outAt: '2026-10-04T08:00:00Z',
      breakMinutes: 0,
      reason: 'vergessen',
    }),
    allow: ['SA', 'AD', 'MG'],
  },
  { method: 'GET', url: () => '/shifts', allow: ['SA', 'AD', 'MG'] },
  {
    method: 'POST',
    url: () => '/shifts',
    body: () => ({
      hotelId: org.hotelA1,
      departmentId: org.deptA1,
      name: 'P',
      startTime: '06:00',
      endTime: '14:00',
    }),
    allow: ['SA', 'AD', 'MG'],
  },
  { method: 'PUT', url: () => `/shifts/${org.deptA1}/staffing`, body: () => ({}), allow: ['SA', 'AD', 'MG'] },
  {
    method: 'GET',
    url: () => `/schedule/grid?hotelIds=${org.hotelA1}&from=2026-10-12`,
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'POST',
    url: () => '/schedule/validate',
    body: () => ({ operation: 'delete', entryId: 999999 }),
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'POST',
    url: () => '/schedule/entries',
    body: () => ({
      hotelId: org.hotelA1,
      employeeId: empId,
      date: '2026-10-12',
      start: '08:00',
      end: '12:00',
    }),
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'PUT',
    url: () => '/schedule/entries/999999',
    body: () => ({ version: 1 }),
    allow: ['SA', 'AD', 'MG'],
  },
  { method: 'DELETE', url: () => '/schedule/entries/999999', allow: ['SA', 'AD', 'MG'] },
  {
    method: 'POST',
    url: () => '/schedule/move',
    body: () => ({ entryId: 999999, version: 1 }),
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'POST',
    url: () => '/schedule/copy',
    body: () => ({ entryId: 999999 }),
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'POST',
    url: () => '/schedule/swap',
    body: () => ({ entryAId: 1, versionA: 1, entryBId: 2, versionB: 1 }),
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'POST',
    url: () => '/schedule/copy-week',
    body: () => ({ hotelIds: [org.hotelA1], fromWeek: '2026-10-12', toWeek: '2026-10-19' }),
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'POST',
    url: () => '/schedule/bulk',
    body: () => ({ operations: [{ op: 'delete', entryId: 999999 }] }),
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'POST',
    url: () => '/schedule/absence',
    body: () => ({ employeeId: empId, from: '2026-12-14', to: '2026-12-14', type: 'off_day' }),
    allow: ['SA', 'AD', 'MG'],
  },
  { method: 'DELETE', url: () => '/schedule/absence/999999', allow: ['SA', 'AD', 'MG'] },
  {
    method: 'POST',
    url: () => '/schedule/publish',
    body: () => ({ hotelIds: [org.hotelA1], from: '2026-10-12', to: '2026-10-18' }),
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'GET',
    url: () => `/schedule/changes?hotelIds=${org.hotelA1}&from=2026-10-12&to=2026-10-18`,
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'POST',
    url: () => '/schedule/revert',
    body: () => ({ hotelIds: [org.hotelA1], from: '2026-10-12', to: '2026-10-18' }),
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'POST',
    url: () => '/schedule/clear-week',
    body: () => ({ hotelIds: [org.hotelA1], from: '2026-10-12', to: '2026-10-18' }),
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'GET',
    url: () =>
      `/schedule/candidates?hotelIds=${org.hotelA1}&departmentId=${org.deptA1}&date=2026-10-12&start=08:00&end=12:00`,
    allow: ['SA', 'AD', 'MG'],
  },
  { method: 'GET', url: () => '/approvals', allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => '/approvals/count', allow: ['SA', 'AD', 'MG'] },
  {
    method: 'PUT',
    url: () => '/approvals/worked-time/999999',
    body: () => ({ decision: 'approve' }),
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'POST',
    url: () => '/approvals/worked-time/bulk-approve',
    body: () => ({ ids: [999999] }),
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'PUT',
    url: () => '/approvals/corrections/999999',
    body: () => ({ decision: 'approve' }),
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'PUT',
    url: () => '/approvals/absences/999999',
    body: () => ({ decision: 'approve' }),
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'GET',
    url: () => `/reports/attendance?hotelId=${org.hotelA1}&from=2026-10-01&to=2026-10-31`,
    allow: ['SA', 'AD', 'MG'],
  },
  { method: 'GET', url: () => '/periods', allow: ['SA', 'AD'] },
  {
    method: 'POST',
    url: () => '/periods/close',
    body: () => ({ companyId: org.companyA, from: '2026-01-01', to: '2026-01-31' }),
    allow: ['SA', 'AD'],
  },
  {
    method: 'POST',
    url: () => '/periods/999999/reopen',
    body: () => ({ reason: 'because' }),
    allow: ['SA', 'AD'],
  },
  { method: 'GET', url: () => '/audit-log', allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/me/schedule?from=2026-10-12&to=2026-10-18', allow: ['EM'] },
  { method: 'GET', url: () => '/me/attendance?from=2026-10-12&to=2026-10-18', allow: ['EM'] },
  { method: 'GET', url: () => '/me/vacation', allow: ['EM'] },
  { method: 'GET', url: () => '/me/time-account', allow: ['EM'] },
  { method: 'GET', url: () => '/me/home', allow: ['EM'] },
  { method: 'GET', url: () => '/me/corrections', allow: ['EM'] },
  { method: 'POST', url: () => '/me/corrections', body: () => ({}), allow: ['EM'] },
  { method: 'GET', url: () => '/me/time-off-requests', allow: ['EM'] },
  { method: 'POST', url: () => '/me/time-off-requests', body: () => ({}), allow: ['EM'] },
  { method: 'DELETE', url: () => '/me/time-off-requests/999999', allow: ['EM'] },
  { method: 'GET', url: () => '/notifications', allow: ['SA', 'AD', 'MG', 'EM'] },
  {
    method: 'GET',
    url: () => `/schedule/export?hotelIds=${org.hotelA1}&from=2026-10-12`,
    allow: ['SA', 'AD', 'MG'],
  },
  { method: 'GET', url: () => `/timesheets?employeeId=${empId}&month=2026-09`, allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => '/me/timesheet?month=2026-09', allow: ['EM'] },
  { method: 'GET', url: () => '/employees/import-template', allow: ['SA', 'AD'] },
  { method: 'POST', url: () => '/employees/import', body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/imports/999999', allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/imports/999999/errors.csv', allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/imports/999999/credentials.pdf', allow: ['SA', 'AD'] },
  { method: 'GET', url: () => `/blackouts?hotelIds=${org.hotelA1}`, allow: ['SA', 'AD', 'MG'] },
  { method: 'POST', url: () => '/blackouts', body: () => ({}), allow: ['SA', 'AD', 'MG'] },
  { method: 'PUT', url: () => '/blackouts/999999', body: () => ({}), allow: ['SA', 'AD', 'MG'] },
  { method: 'DELETE', url: () => '/blackouts/999999', allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => '/me/blackouts?from=2027-01-01&to=2027-01-31', allow: ['EM'] },
  { method: 'GET', url: () => '/vacation/overview?year=2027', allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => '/wishes', allow: ['SA', 'AD', 'MG'] },
  {
    method: 'PUT',
    url: () => '/wishes/leave/999999',
    body: () => ({ decision: 'grant' }),
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'PUT',
    url: () => '/wishes/shift/999999',
    body: () => ({ decision: 'grant' }),
    allow: ['SA', 'AD', 'MG'],
  },
  { method: 'GET', url: () => '/me/shift-wishes', allow: ['EM'] },
  { method: 'POST', url: () => '/me/shift-wishes', body: () => ({}), allow: ['EM'] },
  { method: 'DELETE', url: () => '/me/shift-wishes/999999', allow: ['EM'] },
  { method: 'GET', url: () => '/me/leave-wishes', allow: ['EM'] },
  { method: 'POST', url: () => '/me/leave-wishes', body: () => ({}), allow: ['EM'] },
  { method: 'DELETE', url: () => '/me/leave-wishes/999999', allow: ['EM'] },
  { method: 'POST', url: () => '/vacation/carryover', body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'POST', url: () => '/vacation/notices/send', body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/vacation/notices?year=2027', allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => '/me/vacation-notices', allow: ['EM'] },
  { method: 'PUT', url: () => '/me/vacation-notices/999999/ack', allow: ['EM'] },
  { method: 'GET', url: () => `/employees/${empId}/time-account/ledger`, allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => '/me/time-account/ledger', allow: ['EM'] },
  {
    method: 'POST',
    url: () => `/employees/${empId}/time-account/entries`,
    body: () => ({}),
    allow: ['SA', 'AD'],
  },
  { method: 'GET', url: () => '/hour-categories', allow: ['SA', 'AD', 'MG'] },
  { method: 'POST', url: () => '/hour-categories', body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'PUT', url: () => '/hour-categories/999999', body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'DELETE', url: () => '/hour-categories/999999', allow: ['SA', 'AD'] },
  { method: 'GET', url: () => `/payroll/export?month=2026-09&hotelIds=${org.hotelA1}`, allow: ['SA', 'AD'] },
  {
    method: 'GET',
    url: () => `/compliance/rest-compensation?from=2026-10-01&to=2026-10-31`,
    allow: ['SA', 'AD', 'MG'],
  },
  {
    method: 'GET',
    url: () => `/compliance/replacement-rest?from=2026-10-01&to=2026-10-31`,
    allow: ['SA', 'AD', 'MG'],
  },
  { method: 'GET', url: () => `/compliance/sundays-nights?year=2026`, allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => '/settings/rules', allow: ['SA', 'AD', 'MG'] },
  { method: 'PUT', url: () => '/settings/rules', body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'DELETE', url: () => '/settings/rules', allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/settings/features', allow: ['SA', 'AD', 'MG'] },
  { method: 'PUT', url: () => '/settings/features', body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/me/features', allow: ['SA', 'AD', 'MG', 'EM'] },
  { method: 'GET', url: () => '/analytics/summary?from=2026-10-01&to=2026-10-31', allow: ['SA', 'AD', 'MG'] },
  { method: 'POST', url: () => '/me/swap-requests', body: () => ({}), allow: ['EM'] },
  { method: 'GET', url: () => '/me/swap-requests', allow: ['EM'] },
  { method: 'PUT', url: () => '/me/swap-requests/999999/accept', allow: ['EM'] },
  { method: 'PUT', url: () => '/me/swap-requests/999999/decline', allow: ['EM'] },
  { method: 'DELETE', url: () => '/me/swap-requests/999999', allow: ['EM'] },
  { method: 'GET', url: () => '/approvals/swaps', allow: ['SA', 'AD', 'MG'] },
  {
    method: 'PUT',
    url: () => '/approvals/swaps/999999',
    body: () => ({ decision: 'approve' }),
    allow: ['SA', 'AD', 'MG'],
  },
  { method: 'GET', url: () => '/me/punch', allow: ['EM'] },
  { method: 'POST', url: () => '/me/punch/in', body: () => ({}), allow: ['EM'] },
  { method: 'POST', url: () => '/me/punch/out', body: () => ({}), allow: ['EM'] },
  { method: 'POST', url: () => '/me/punch/break', body: () => ({}), allow: ['EM'] },
  { method: 'PUT', url: () => '/occupancy', body: () => ({}), allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => '/occupancy', allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => '/staffing-rules', allow: ['SA', 'AD', 'MG'] },
  { method: 'POST', url: () => '/staffing-rules', body: () => ({}), allow: ['SA', 'AD', 'MG'] },
  { method: 'DELETE', url: () => '/staffing-rules/999999', allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => '/staffing/suggestions', allow: ['SA', 'AD', 'MG'] },
  { method: 'POST', url: () => '/staffing/apply', body: () => ({}), allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => '/api-keys', allow: ['SA', 'AD'] },
  { method: 'POST', url: () => '/api-keys', body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'DELETE', url: () => '/api-keys/999999', allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/sso/provider', allow: ['SA', 'AD'] },
  { method: 'PUT', url: () => '/sso/provider', body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'DELETE', url: () => '/sso/provider', allow: ['SA', 'AD'] },
  { method: 'POST', url: () => `/employees/${empId}/badge`, body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'DELETE', url: () => `/employees/${empId}/badge`, allow: ['SA', 'AD'] },
  { method: 'POST', url: () => '/open-shifts', body: () => ({}), allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => '/open-shifts', allow: ['SA', 'AD', 'MG'] },
  { method: 'DELETE', url: () => '/open-shifts/999999', allow: ['SA', 'AD', 'MG'] },
  {
    method: 'PUT',
    url: () => '/open-shifts/claims/999999',
    body: () => ({ decision: 'approve' }),
    allow: ['SA', 'AD', 'MG'],
  },
  { method: 'GET', url: () => '/me/open-shifts', allow: ['EM'] },
  { method: 'POST', url: () => '/me/open-shifts/999999/claim', allow: ['EM'] },
  { method: 'DELETE', url: () => '/me/open-shifts/999999/claim', allow: ['EM'] },
  { method: 'GET', url: () => '/qualifications', allow: ['SA', 'AD', 'MG'] },
  { method: 'POST', url: () => '/qualifications', body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'PUT', url: () => '/qualifications/999999', body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'DELETE', url: () => '/qualifications/999999', allow: ['SA', 'AD'] },
  { method: 'GET', url: () => `/employees/${empId}/qualifications`, allow: ['SA', 'AD', 'MG'] },
  {
    method: 'PUT',
    url: () => `/employees/${empId}/qualifications`,
    body: () => ({}),
    allow: ['SA', 'AD', 'MG'],
  },
  { method: 'GET', url: () => '/me/qualifications', allow: ['EM'] },
  { method: 'GET', url: () => '/me/availability', allow: ['EM'] },
  { method: 'POST', url: () => '/me/availability', body: () => ({}), allow: ['EM'] },
  { method: 'DELETE', url: () => '/me/availability/999999', allow: ['EM'] },
  { method: 'GET', url: () => '/availability', allow: ['SA', 'AD', 'MG'] },
  { method: 'POST', url: () => `/employees/${empId}/documents`, allow: ['SA', 'AD'] },
  { method: 'GET', url: () => `/employees/${empId}/documents`, allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/documents/999999/download', allow: ['SA', 'AD'] },
  { method: 'DELETE', url: () => '/documents/999999', allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/documents/expiring', allow: ['SA', 'AD'] },
  { method: 'GET', url: () => '/me/documents', allow: ['EM'] },
  { method: 'GET', url: () => '/me/documents/999999/download', allow: ['EM'] },
  { method: 'POST', url: () => `/employees/${empId}/terminate`, body: () => ({}), allow: ['SA', 'AD'] },
  { method: 'GET', url: () => `/employees/${empId}/exit-statement`, allow: ['SA', 'AD'] },
  { method: 'POST', url: () => '/announcements', body: () => ({}), allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => '/announcements', allow: ['SA', 'AD', 'MG'] },
  { method: 'DELETE', url: () => '/announcements/999999', allow: ['SA', 'AD', 'MG'] },
  { method: 'GET', url: () => '/me/announcements', allow: ['EM'] },
  { method: 'PUT', url: () => '/me/announcements/999999/ack', allow: ['EM'] },
  { method: 'POST', url: () => '/me/questions', body: () => ({}), allow: ['EM'] },
  { method: 'GET', url: () => '/me/questions', allow: ['EM'] },
  { method: 'GET', url: () => '/questions', allow: ['SA', 'AD', 'MG'] },
  {
    method: 'PUT',
    url: () => '/questions/999999/answer',
    body: () => ({ answer: 'x' }),
    allow: ['SA', 'AD', 'MG'],
  },
  { method: 'GET', url: () => '/feed', allow: ['SA', 'AD', 'MG', 'EM'] },
  { method: 'POST', url: () => '/feed/posts', body: () => ({}), allow: ['SA', 'AD', 'MG', 'EM'] },
  { method: 'DELETE', url: () => '/feed/posts/999999', allow: ['SA', 'AD', 'MG', 'EM'] },
  { method: 'PUT', url: () => '/feed/posts/999999/like', allow: ['SA', 'AD', 'MG', 'EM'] },
  { method: 'POST', url: () => '/me/calendar-feed', allow: ['EM'] },
  { method: 'DELETE', url: () => '/me/calendar-feed', allow: ['EM'] },
  { method: 'GET', url: () => '/me/team-absences?from=2026-10-01&to=2026-10-31', allow: ['EM'] },
  {
    method: 'PUT',
    url: () => '/settings/team-visibility',
    body: () => ({ value: 'none' }),
    allow: ['SA', 'AD'],
  },
];

const tokenFor = (r: Role): string | null =>
  r === 'SA'
    ? org.saToken
    : r === 'AD'
      ? org.adminA.token
      : r === 'MG'
        ? org.mgrA1.token
        : r === 'EM'
          ? empToken
          : null;

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
