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
beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-20T10:00:00Z') });
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  emp = await employeeTokens(ctx, fx, ['maria']);
});
afterAll(async () => stopApp(ctx));

const patterns = (token: string, q = 'level=department&granularity=month', hotel = fx.hotelA1) =>
  call(ctx, 'GET', `/analytics/patterns?hotelIds=${hotel}&from=2026-10-01&to=2026-10-31&${q}`, token);

// an approved punch of a planned 06:00-14:00 shift (30 min break): planned net 7.5 h
const punch = (employeeId: number, date: string, paid: number, startVar: number, endVar: number) =>
  ctx.db
    .insertInto('punch_record')
    .values({
      employee_id: employeeId,
      hotel_id: fx.hotelA1,
      shift_date: date,
      planned_start: new Date(`${date}T04:00:00Z`),
      planned_end: new Date(`${date}T12:00:00Z`),
      actual_punch_in: new Date(`${date}T04:20:00Z`),
      actual_punch_out: new Date(`${date}T13:00:00Z`),
      paid_start: new Date(`${date}T04:20:00Z`),
      paid_end: new Date(`${date}T13:00:00Z`),
      actual_break_minutes: 30,
      required_break_minutes: 30,
      paid_hours: paid,
      start_variation_minutes: startVar,
      end_variation_minutes: endVar,
      approval_status: 'approved',
    } as any)
    .execute();

describe('analytics patterns', () => {
  it('are for admins and super admins only', async () => {
    expect((await patterns(fx.mgrA1.token)).status).toBe(403);
    expect((await patterns(emp.maria!)).status).toBe(403);
    expect((await patterns(fx.adminB.token)).status).toBe(403); // another company's hotel
    expect((await patterns(fx.adminA.token)).status).toBe(200);
    expect(
      (
        await call(
          ctx,
          'GET',
          `/analytics/patterns?hotelIds=${fx.hotelA1}&from=2026-10-31&to=2026-10-01`,
          fx.adminA.token,
        )
      ).status,
    ).toBe(400);
  });

  it('count overtime, late and long stays as totals; small groups are hidden; late and long stay are off by default', async () => {
    // five Rezeption employees, each 1 h over plan, late by 20 min and staying 45 min after the end
    for (const id of [fx.emp.maria, fx.emp.jon, fx.emp.lena, fx.emp.tom, fx.emp.cap])
      await punch(id!, '2026-10-06', 8.5, 20, 45);
    // a single housekeeping employee: below the minimum group size
    await punch(fx.emp.piotr!, '2026-10-06', 8.5, 20, 45);

    const r = await patterns(fx.adminA.token);
    expect(r.body.periods).toEqual(['2026-10']);
    const rez = r.body.groups.find((g: any) => g.name === 'Rezeption');
    expect(rez.metrics.overtime.unit).toBe('hours');
    expect(rez.metrics.overtime.values[0]).toBe(5);
    expect(rez.metrics.overtime.byWeekday[1]).toBe(5); // 6 Oct 2026 is a Tuesday
    // late and long stay are switched off until the company agrees them
    expect(rez.metrics.late).toBeNull();
    expect(rez.metrics.longStay).toBeNull();
    // one person is not enough
    const hk = r.body.groups.find((g: any) => g.name === 'Housekeeping');
    expect(hk.metrics.overtime.values[0]).toBeNull();
    expect(hk.metrics.overtime.total).toBeNull();
    // sickness needs ten people; this department has five
    expect(rez.metrics.sick.values[0]).toBeNull();
    // no person level data
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('Maria');
    expect(text).not.toContain('employee_id');

    // switched on by the company: every planned punch was late and a long stay
    for (const feature of ['analytics_late', 'analytics_long_stay'])
      expect(
        (
          await call(ctx, 'PUT', `/settings/features?companyId=${fx.companyA}`, fx.adminA.token, {
            feature,
            enabled: true,
          })
        ).status,
      ).toBe(200);
    const on = await patterns(fx.adminA.token);
    const rez2 = on.body.groups.find((g: any) => g.name === 'Rezeption');
    expect(rez2.metrics.late).toMatchObject({ unit: 'percent', total: 100 });
    expect(rez2.metrics.longStay.values[0]).toBe(100);
    // hotel and shift level work too, and weeks are a granularity
    expect((await patterns(fx.adminA.token, 'level=hotel&granularity=week')).body.periods).toHaveLength(5);
    expect((await patterns(fx.adminA.token, 'level=shift&granularity=month')).status).toBe(200);
  });

  it('show the share of shifts lost to sickness only for groups of at least ten people', async () => {
    // ten more employees, each planned on Monday 26 Oct; one of them calls in sick
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await call(
        ctx,
        'POST',
        '/employees',
        fx.adminA.token,
        empBody(fx, { firstName: `Group${i}`, lastName: 'Member' }),
      );
      expect(r.status).toBe(201);
      ids.push(r.body.employeeId);
    }
    for (const id of ids)
      expect(
        (
          await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
            hotelId: fx.hotelA1,
            employeeId: id,
            shiftId: fx.early,
            date: '2026-10-26',
          })
        ).status,
      ).toBe(201);
    expect(
      (
        await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
          employeeId: ids[0],
          from: '2026-10-26',
          to: '2026-10-26',
          type: 'sick_leave',
        })
      ).status,
    ).toBe(201);
    const r = await patterns(fx.adminA.token, 'level=hotel&granularity=month');
    const hotel = r.body.groups[0];
    expect(hotel.metrics.sick.unit).toBe('percent');
    expect(hotel.metrics.sick.values[0]).toBe(10); // 1 of 10 planned shifts
    expect(hotel.metrics.sick.byWeekday[0]).toBe(10); // Monday
  });
});
