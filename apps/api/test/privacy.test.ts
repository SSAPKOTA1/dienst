import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../src/lib/security';
import { eligibleFrom, logPersonalDataView, runRetention } from '../src/services/privacy';
import {
  call,
  empBody,
  loginAs,
  setupOrg,
  startApp,
  stopApp,
  TEST_PASSWORD,
  type Org,
  type TestCtx,
} from './helpers';

let ctx: TestCtx;
let org: Org;
beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-04T10:00:00Z') });
  org = await setupOrg(ctx);
});
afterAll(async () => stopApp(ctx));

const make = async (over: Record<string, unknown> = {}) => {
  const r = await call(ctx, 'POST', '/employees', org.adminA.token, empBody(org, over));
  expect(r.status).toBe(201);
  return r.body as { employeeId: number; userId: number; username: string };
};
/** Marks a person as having left on `end` without going through the offboarding flow. */
const leave = (id: number, end: string) =>
  ctx.db
    .updateTable('employee')
    .set({ status: 'inactive', contract_end_date: end })
    .where('employee_id', '=', id)
    .execute();

describe('eligibleFrom', () => {
  it('is the day after contract end plus the retention months, never below 24 months', () => {
    expect(eligibleFrom('2023-01-31', 36)).toBe('2026-02-01');
    expect(eligibleFrom('2023-01-31', 6)).toBe('2025-02-01');
    expect(eligibleFrom('2024-02-29', 24)).toBe('2026-03-02');
  });
});

describe('data export', () => {
  it('lets an admin export a person, logs it, and refuses another company', async () => {
    const e = await make({ firstName: 'Export', lastName: 'Person' });
    const ok = await call(ctx, 'GET', `/employees/${e.employeeId}/data-export`, org.adminA.token);
    expect(ok.status).toBe(200);
    expect(ok.res.headers['content-disposition']).toContain('personal-data-');
    expect(ok.body.profile.first_name).toBe('Export');
    expect(ok.body.contracts).toHaveLength(1);
    expect(ok.body.profile).not.toHaveProperty('pin_hash');
    expect((await call(ctx, 'GET', `/employees/${e.employeeId}/data-export`, org.adminB.token)).status).toBe(
      403,
    );
    expect((await call(ctx, 'GET', `/employees/${e.employeeId}/data-export`, org.mgrA1.token)).status).toBe(
      403,
    );
    const log = await call(ctx, 'GET', `/employees/${e.employeeId}/access-log`, org.adminA.token);
    expect(log.status).toBe(200);
    expect(log.body.items.map((i: { action: string }) => i.action)).toContain('personal_data_exported');
  });
  it('lets an employee export their own data and see who looked at it', async () => {
    const e = await make({ firstName: 'Self', lastName: 'Service' });
    await ctx.db
      .updateTable('user_account')
      .set({
        status: 'active',
        password_hash: await hashSecret(TEST_PASSWORD),
      })
      .where('id', '=', e.userId)
      .execute();
    const token = await loginAs(ctx, e.username, 'employee', { employeeId: e.employeeId });
    const mine = await call(ctx, 'GET', '/me/data-export', token);
    expect(mine.status).toBe(200);
    expect(mine.body.profile.first_name).toBe('Self');
    // a manager opens the record
    await call(ctx, 'GET', `/employees/${e.employeeId}`, org.mgrA1.token);
    const log = await call(ctx, 'GET', '/me/access-log', token);
    expect(log.status).toBe(200);
    const items = log.body.items as Array<{ action: string; actorType: string }>;
    expect(items.some((i) => i.action === 'personal_data_viewed' && i.actorType === 'manager')).toBe(true);
    // the employee's own exports are not listed as somebody else looking
    expect(items.every((i) => !('actor' in i))).toBe(true);
  });
});

describe('access log of record views', () => {
  it('logs one entry per reader within ten minutes', async () => {
    const e = await make({ firstName: 'Viewed', lastName: 'Once' });
    await call(ctx, 'GET', `/employees/${e.employeeId}`, org.mgrA1.token);
    await call(ctx, 'GET', `/employees/${e.employeeId}`, org.mgrA1.token);
    await call(ctx, 'GET', `/employees/${e.employeeId}`, org.adminA.token);
    const log = await call(ctx, 'GET', `/employees/${e.employeeId}/access-log`, org.adminA.token);
    const views = log.body.items.filter((i: { action: string }) => i.action === 'personal_data_viewed');
    expect(views).toHaveLength(2);
    // outside the window (audit rows are append-only, so the window is shortened instead of ageing rows)
    const emp = await ctx.db
      .selectFrom('employee')
      .selectAll()
      .where('employee_id', '=', e.employeeId)
      .executeTakeFirstOrThrow();
    await logPersonalDataView(ctx.db, { userId: org.mgrA1.userId, type: 'manager' }, emp, 0);
    const again = await call(ctx, 'GET', `/employees/${e.employeeId}/access-log`, org.adminA.token);
    expect(
      again.body.items.filter((i: { action: string }) => i.action === 'personal_data_viewed'),
    ).toHaveLength(3);
  });
});

describe('anonymisation', () => {
  it('refuses while employed and while the retention period runs', async () => {
    const e = await make({ firstName: 'Still', lastName: 'Here' });
    const a = await call(ctx, 'POST', `/employees/${e.employeeId}/anonymise`, org.adminA.token, {
      reason: 'request',
    });
    expect(a.status).toBe(409);
    expect(a.body.error.details.code).toBe('STILL_EMPLOYED');
    await leave(e.employeeId, '2026-03-31');
    const b = await call(ctx, 'POST', `/employees/${e.employeeId}/anonymise`, org.adminA.token, {
      reason: 'request',
    });
    expect(b.status).toBe(409);
    expect(b.body.error.details.code).toBe('RETENTION_ACTIVE');
    expect(b.body.error.details.eligibleFrom).toBe('2029-04-01');
  });
  it('removes identity and personal extras, keeps the hours records, and cannot be exported afterwards', async () => {
    const e = await make({
      firstName: 'Gone',
      lastName: 'Forever',
      email: 'gone@example.org',
      phone: '0151 1234',
    });
    await ctx.db
      .insertInto('notification')
      .values({
        user_id: e.userId,
        employee_id: e.employeeId,
        type: 'x',
        title: 'secret',
        body: 'secret',
      } as never)
      .execute()
      .catch(() => undefined);
    await ctx.db
      .updateTable('employee')
      .set({ contract_start_date: '2020-01-01' })
      .where('employee_id', '=', e.employeeId)
      .execute();
    await leave(e.employeeId, '2022-06-30');
    const res = await call(ctx, 'POST', `/employees/${e.employeeId}/anonymise`, org.adminA.token, {
      reason: 'Art. 17 request',
    });
    expect(res.status).toBe(200);
    expect(res.body.accountAnonymised).toBe(true);
    const emp = await ctx.db
      .selectFrom('employee')
      .selectAll()
      .where('employee_id', '=', e.employeeId)
      .executeTakeFirstOrThrow();
    expect(emp.first_name).toBe('Gelöscht');
    expect(emp.last_name).toBe(`#${e.employeeId}`);
    expect(emp.contact_email).toBeNull();
    expect(emp.phone).toBeNull();
    expect(emp.date_of_birth).toBe('1990-01-01');
    expect(emp.anonymised_at).not.toBeNull();
    const u = await ctx.db
      .selectFrom('user_account')
      .selectAll()
      .where('id', '=', e.userId)
      .executeTakeFirstOrThrow();
    expect(u.email).toBeNull();
    expect(u.username).toBe(`deleted-${e.userId}`);
    expect(u.status).toBe('disabled');
    expect(u.password_hash).toBeNull();
    // contracts stay (statutory records)
    expect(
      (
        await ctx.db
          .selectFrom('employee_contract')
          .select('id')
          .where('employee_id', '=', e.employeeId)
          .execute()
      ).length,
    ).toBe(1);
    const again = await call(ctx, 'POST', `/employees/${e.employeeId}/anonymise`, org.adminA.token, {
      reason: 'again',
    });
    expect(again.status).toBe(409);
    expect((await call(ctx, 'GET', `/employees/${e.employeeId}/data-export`, org.adminA.token)).status).toBe(
      409,
    );
    const audit = await ctx.db
      .selectFrom('audit_log')
      .select(['action', 'reason'])
      .where('action', '=', 'employee_anonymised')
      .where('entity_id', '=', e.employeeId)
      .execute();
    expect(audit).toEqual([{ action: 'employee_anonymised', reason: 'Art. 17 request' }]);
  });
  it('the daily retention job anonymises only people past their company retention', async () => {
    const old = await make({ firstName: 'Old', lastName: 'Contract' });
    const recent = await make({ firstName: 'Recent', lastName: 'Leaver' });
    await ctx.db
      .updateTable('employee')
      .set({ contract_start_date: '2019-01-01' })
      .where('employee_id', '=', old.employeeId)
      .execute();
    await leave(old.employeeId, '2023-01-31'); // + 36 months = 2026-01-31, before 2026-10-04
    await leave(recent.employeeId, '2025-12-31');
    const n = await runRetention(ctx.db, ctx.now.value);
    expect(n).toBe(1);
    const rows = await ctx.db
      .selectFrom('employee')
      .select(['employee_id', 'anonymised_at'])
      .where('employee_id', 'in', [old.employeeId, recent.employeeId])
      .execute();
    const by = new Map(rows.map((r) => [r.employee_id, r.anonymised_at]));
    expect(by.get(old.employeeId)).not.toBeNull();
    expect(by.get(recent.employeeId)).toBeNull();
    // idempotent
    expect(await runRetention(ctx.db, ctx.now.value)).toBe(0);
  });
});
