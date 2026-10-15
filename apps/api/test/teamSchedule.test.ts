import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  ctxHolder,
  empBody,
  employeeTokens,
  planFixture,
  startApp,
  stopApp,
  type PlanFx,
  type TestCtx,
} from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
let emp: Record<string, string>;

const Q = '/me/team-schedule?from=2027-03-01&to=2027-03-07';
const add = async (adminToken: string, hotelId: number, key: string, shiftId: number, date: string) => {
  const r = await call(ctx, 'POST', '/schedule/entries', adminToken, {
    hotelId,
    employeeId: fx.emp[key],
    shiftId,
    date,
  });
  expect(r.status).toBe(201);
};

beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-20T10:00:00Z') });
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  // an employee of another company
  const b = await call(
    ctx,
    'POST',
    '/employees',
    fx.adminB.token,
    empBody(fx, {
      firstName: 'Bea',
      lastName: 'Fremd',
      primaryHotelId: fx.hotelB1,
      primaryDepartmentId: fx.deptB1,
    }),
  );
  expect(b.status).toBe(201);
  fx.emp.bea = b.body.employeeId;
  emp = await employeeTokens(ctx, fx, ['maria', 'jon', 'tom', 'piotr', 'bea']);
  await add(fx.adminA.token, fx.hotelA1, 'maria', fx.early, '2027-03-02');
  await add(fx.adminA.token, fx.hotelA1, 'jon', fx.late, '2027-03-02');
  await add(fx.adminA.token, fx.hotelA1, 'tom', fx.early, '2027-03-03');
  await add(fx.adminA.token, fx.hotelA2, 'tom', fx.early2, '2027-03-04');
  await add(fx.adminA.token, fx.hotelA1, 'piotr', fx.hk, '2027-03-10'); // next week, stays a draft
  await call(ctx, 'POST', '/schedule/publish', fx.adminA.token, {
    hotelIds: [fx.hotelA1, fx.hotelA2],
    from: '2027-03-01',
    to: '2027-03-04',
  });
});
afterAll(async () => stopApp(ctx));

describe('team schedule (employee portal)', () => {
  it('shows colleagues of my hotels with names and times, own entries marked, no private fields', async () => {
    const r = await call(ctx, 'GET', Q, emp.maria!);
    expect(r.status).toBe(200);
    const names = r.body.entries.map((e: { displayName: string }) => e.displayName);
    expect(names).toHaveLength(3); // maria, jon, tom@A1 - not tom@A2 (maria is not assigned there)
    expect(r.body.entries.filter((e: { mine: boolean }) => e.mine)).toHaveLength(1);
    expect(r.body.hotels.map((h: { id: number }) => h.id)).toEqual([fx.hotelA1]);
    for (const e of r.body.entries)
      expect(Object.keys(e).sort()).toEqual(
        ['date', 'displayName', 'employeeId', 'end', 'hotelId', 'id', 'mine', 'shiftName', 'start'].sort(),
      );
    expect(JSON.stringify(r.body)).not.toMatch(/hours|break|email|phone|note|wish|reason|sick/i);
  });

  it('shows only published plans', async () => {
    const r = await call(ctx, 'GET', '/me/team-schedule?from=2027-03-08&to=2027-03-14', emp.maria!);
    expect(r.body.entries).toEqual([]);
  });

  it('a multi-hotel employee sees both hotels and can filter, but only their own hotels', async () => {
    const all = await call(ctx, 'GET', Q, emp.tom!);
    expect(all.body.hotels).toHaveLength(2);
    expect(all.body.entries).toHaveLength(4);
    const one = await call(ctx, 'GET', `${Q}&hotelId=${fx.hotelA2}`, emp.tom!);
    expect(one.body.entries.every((e: { hotelId: number }) => e.hotelId === fx.hotelA2)).toBe(true);
    const foreign = await call(ctx, 'GET', `${Q}&hotelId=${fx.hotelB1}`, emp.tom!);
    expect(foreign.body.entries).toEqual([]);
  });

  it('never leaks another company or hotel', async () => {
    const r = await call(ctx, 'GET', `${Q}&hotelId=${fx.hotelA1}`, emp.bea!);
    expect(r.body.entries).toEqual([]);
    expect(r.body.hotels.map((h: { id: number }) => h.id)).toEqual([fx.hotelB1]);
  });

  it('is read-only and limited to employees and a 14 day range', async () => {
    expect((await call(ctx, 'POST', '/me/team-schedule', emp.maria!, {})).status).toBeGreaterThanOrEqual(404);
    expect((await call(ctx, 'GET', Q, fx.adminA.token)).status).toBe(403);
    expect((await call(ctx, 'GET', Q, null)).status).toBe(401);
    const long = await call(ctx, 'GET', '/me/team-schedule?from=2027-03-01&to=2027-03-30', emp.maria!);
    expect(long.status).toBe(400);
  });

  it('shows absences as neutral "away" only when the company allows it, never sickness', async () => {
    const ab = await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
      employeeId: fx.emp.jon,
      from: '2027-03-08',
      to: '2027-03-09',
      type: 'annual_leave',
    });
    expect(ab.status, JSON.stringify(ab.body)).toBe(201);
    await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
      employeeId: fx.emp.piotr,
      from: '2027-03-08',
      to: '2027-03-08',
      type: 'sick_leave',
    });
    expect(
      (await call(ctx, 'GET', '/me/team-schedule?from=2027-03-08&to=2027-03-14', emp.maria!)).body.absences,
    ).toEqual([]);
    await call(ctx, 'PUT', '/settings/team-visibility', fx.adminA.token, { value: 'names_only' });
    const Q2 = '/me/team-schedule?from=2027-03-08&to=2027-03-14';
    const on = await call(ctx, 'GET', Q2, emp.maria!);
    expect(on.body.absencesEnabled).toBe(true);
    expect(on.body.absences).toEqual([
      { employeeId: fx.emp.jon, displayName: 'Jon T.', from: '2027-03-08', to: '2027-03-09', mine: false },
    ]);
    expect(JSON.stringify(on.body)).not.toMatch(/annual|sick|type/);
  });
});
