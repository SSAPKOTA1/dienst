import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, ctxHolder, planFixture, startApp, stopApp, type PlanFx, type TestCtx } from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
let key: string;
let hotelKey: string;

beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-04T10:00:00Z') });
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  const rec = (empId: number, hotelId: number, date: string, status: string, hours: number) =>
    ctx.db
      .insertInto('punch_record')
      .values({
        employee_id: empId,
        hotel_id: hotelId,
        shift_date: date,
        source: 'kiosk',
        actual_punch_in: new Date(`${date}T06:00:00Z`),
        actual_punch_out: new Date(`${date}T14:00:00Z`),
        paid_start: new Date(`${date}T06:00:00Z`),
        paid_end: new Date(`${date}T14:00:00Z`),
        actual_break_minutes: 30,
        paid_hours: hours,
        approval_status: status,
      })
      .execute();
  await rec(fx.emp.maria, fx.hotelA1, '2026-10-05', 'approved', 7.5);
  await rec(fx.emp.jon, fx.hotelA1, '2026-10-05', 'pending', 7.5);
  await rec(fx.emp.tom, fx.hotelA2, '2026-10-05', 'approved', 7.5);
  const abs = (empId: number, type: string, start: string) =>
    ctx.db
      .insertInto('time_off')
      .values({
        employee_id: empId,
        start_date: start,
        end_date: start,
        time_off_days: 1,
        type,
        status: 'approved',
        counts_against_allowance: type === 'annual_leave',
        created_by_user_id: fx.adminA.userId,
      })
      .execute();
  await abs(fx.emp.maria, 'annual_leave', '2026-10-06');
  await abs(fx.emp.jon, 'sick_leave', '2026-10-06');
});
afterAll(async () => stopApp(ctx));

const pub = (url: string, k: string | null = key, header: 'bearer' | 'x' = 'x', method = 'GET') =>
  ctx.app
    .inject({
      method: method as any,
      url: `/api/public/v1${url}`,
      headers: k ? (header === 'x' ? { 'x-api-key': k } : { authorization: `Bearer ${k}` }) : {},
    })
    .then((r) => ({ status: r.statusCode, body: r.json() as any }));

describe('key management', () => {
  it('admins create keys that are shown once and stored as a hash; managers cannot', async () => {
    const mk = await call(ctx, 'POST', '/api-keys', fx.adminA.token, {
      companyId: fx.companyA,
      name: 'Payroll',
    });
    expect(mk.status).toBe(201);
    key = mk.body.key;
    expect(key).toMatch(/^dk_/);
    const row = await ctx.db.selectFrom('api_key').selectAll().executeTakeFirstOrThrow();
    expect(row.key_hash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(key);
    const list = await call(ctx, 'GET', '/api-keys', fx.adminA.token);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect((await call(ctx, 'GET', '/api-keys', fx.adminB.token)).body.items).toHaveLength(0);
    expect(
      (await call(ctx, 'POST', '/api-keys', fx.mgrA1.token, { companyId: fx.companyA, name: 'x' })).status,
    ).toBe(403);
    expect(
      (await call(ctx, 'POST', '/api-keys', fx.adminA.token, { companyId: fx.companyB, name: 'x' })).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'POST', '/api-keys', fx.adminA.token, {
          companyId: fx.companyA,
          hotelId: fx.hotelB1,
          name: 'x',
        })
      ).status,
    ).toBe(403);
    const hk = await call(ctx, 'POST', '/api-keys', fx.adminA.token, {
      companyId: fx.companyA,
      hotelId: fx.hotelA1,
      name: 'Hotel 1',
    });
    hotelKey = hk.body.key;
    expect(
      await ctx.db.selectFrom('audit_log').select('action').where('action', '=', 'api_key_created').execute(),
    ).toHaveLength(2);
  });
});

describe('public API', () => {
  it('needs a valid key, accepts both header styles and is read-only', async () => {
    expect((await pub('/hotels', null)).status).toBe(401);
    expect((await pub('/hotels', 'dk_nonsense')).status).toBe(401);
    expect((await pub('/hotels', 'not-a-key')).status).toBe(401);
    expect((await pub('/hotels', key, 'bearer')).body.items.map((h: any) => h.id).sort()).toEqual(
      [fx.hotelA1, fx.hotelA2].sort(),
    );
    expect((await pub('/hotels', key, 'x', 'POST')).status).toBe(404);
    expect((await pub('/hotels', key, 'x', 'DELETE')).status).toBe(404);
    const spec = await pub('/openapi.json', null);
    expect(spec.body.openapi).toBe('3.0.3');
    expect(Object.keys(spec.body.paths)).toContain('/attendance');
    const used = await ctx.db
      .selectFrom('api_key')
      .select('last_used_at')
      .where('name', '=', 'Payroll')
      .executeTakeFirstOrThrow();
    expect(used.last_used_at).not.toBeNull();
  });

  it('returns employees without private data and only inside the company', async () => {
    const e = await pub('/employees');
    expect(e.status).toBe(200);
    expect(e.body.items.length).toBe(6);
    const first = e.body.items[0];
    expect(Object.keys(first).sort()).toEqual([
      'department',
      'firstName',
      'id',
      'lastName',
      'personnelNumber',
      'primaryHotelId',
      'status',
    ]);
    expect((await pub('/employees?limit=2')).body.items).toHaveLength(2);
    expect((await pub('/employees?limit=2&offset=5')).body.items).toHaveLength(1);
    expect((await pub('/employees?limit=501')).status).toBe(400);
    expect((await pub(`/employees?hotelId=${fx.hotelB1}`)).status).toBe(403);
  });

  it('returns approved hours only and scopes a hotel key to its hotel', async () => {
    const all = await pub('/attendance?from=2026-10-01&to=2026-10-31');
    expect(all.body.items.map((i: any) => i.employeeId).sort()).toEqual([fx.emp.maria, fx.emp.tom].sort());
    expect(all.body.items[0]).toMatchObject({ paidHours: 7.5, breakMinutes: 30, date: '2026-10-05' });
    const one = await pub('/attendance?from=2026-10-01&to=2026-10-31', hotelKey);
    expect(one.body.items.map((i: any) => i.employeeId)).toEqual([fx.emp.maria]);
    expect(
      (await pub(`/attendance?from=2026-10-01&to=2026-10-31&hotelId=${fx.hotelA2}`, hotelKey)).status,
    ).toBe(403);
    expect((await pub('/attendance?from=2026-10-01&to=2028-10-31')).status).toBe(400);
    expect((await pub('/attendance?from=2026-10-01')).status).toBe(400);
  });

  it('names only vacation and hides every other kind of absence', async () => {
    const a = await pub('/absences?from=2026-10-01&to=2026-10-31');
    expect(a.body.items.map((i: any) => i.type).sort()).toEqual(['absence', 'vacation']);
    expect(JSON.stringify(a.body)).not.toContain('sick');
  });

  it('serves published shifts only', async () => {
    await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.maria,
      shiftId: fx.early,
      date: '2026-10-12',
    });
    expect((await pub('/schedule?from=2026-10-12&to=2026-10-12')).body.items).toHaveLength(0);
    await call(ctx, 'POST', '/schedule/publish', fx.adminA.token, {
      hotelIds: [fx.hotelA1],
      from: '2026-10-12',
      to: '2026-10-18',
    });
    const s = await pub('/schedule?from=2026-10-12&to=2026-10-12');
    expect(s.body.items).toMatchObject([
      { employeeId: fx.emp.maria, date: '2026-10-12', shift: 'Früh', breakMinutes: 30 },
    ]);
  });

  it('stops working when the key is revoked, and revoking is limited to the own company', async () => {
    const id = (await call(ctx, 'GET', '/api-keys', fx.adminA.token)).body.items.find(
      (k: any) => k.name === 'Payroll',
    ).id;
    expect((await call(ctx, 'DELETE', `/api-keys/${id}`, fx.adminB.token)).status).toBe(403);
    expect((await call(ctx, 'DELETE', `/api-keys/${id}`, fx.adminA.token)).status).toBe(204);
    expect((await call(ctx, 'DELETE', `/api-keys/${id}`, fx.adminA.token)).status).toBe(204); // idempotent
    expect((await pub('/hotels')).status).toBe(401);
    expect((await pub('/hotels', hotelKey)).status).toBe(200);
  });
});
