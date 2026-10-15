import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  ctxHolder,
  empBody,
  planFixture,
  startApp,
  stopApp,
  type PlanFx,
  type TestCtx,
} from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-20T10:00:00Z') });
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
});
afterAll(async () => stopApp(ctx));

const mk = async (over: Record<string, unknown>) => {
  const r = await call(ctx, 'POST', '/employees', fx.adminA.token, empBody(fx, over));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.employeeId as number;
};
const ledger = (id: number) => call(ctx, 'GET', `/employees/${id}/time-account/ledger`, fx.adminA.token);
const contracts = async (id: number) =>
  (await call(ctx, 'GET', `/employees/${id}/contracts`, fx.adminA.token)).body.items;
// an approved punch of paid hours on a day of September 2026
const punch = (employeeId: number, date: string, paid: number) =>
  ctx.db
    .insertInto('punch_record')
    .values({
      employee_id: employeeId,
      hotel_id: fx.hotelA1,
      shift_date: date,
      actual_punch_in: new Date(`${date}T05:00:00Z`),
      actual_punch_out: new Date(`${date}T15:00:00Z`),
      paid_start: new Date(`${date}T05:00:00Z`),
      paid_end: new Date(`${date}T15:00:00Z`),
      paid_hours: paid,
      approval_status: 'approved',
    } as any)
    .execute();

describe('time account for every employee with a target', () => {
  it('hourly staff have a balance, with a weekly or a monthly target', async () => {
    const weekly = await mk({
      firstName: 'Hourly',
      lastName: 'Week',
      workingModel: 'hourly',
      targetHoursPerWeek: 10,
      contractStartDate: '2026-09-01',
    });
    const monthly = await mk({
      firstName: 'Hourly',
      lastName: 'Month',
      workingModel: 'hourly',
      targetHoursPerWeek: undefined,
      targetHoursPerMonth: 130,
      contractStartDate: '2026-09-01',
    });
    expect((await ledger(weekly)).body.balanceHours).toBeTypeOf('number');
    expect((await ledger(monthly)).body.balanceHours).toBeTypeOf('number');
    // no target at all: no account
    const none = await mk({
      firstName: 'No',
      lastName: 'Target',
      workingModel: 'hourly',
      targetHoursPerWeek: null,
    });
    expect((await ledger(none)).body.balanceHours).toBeNull();
  });
});

describe('holiday bonus (contract flag "gets public holiday")', () => {
  it('adds one day of target hours for every holiday worked, only when the flag is on', async () => {
    await ctx.db
      .insertInto('public_holiday')
      .values({ scope: 'national', date: '2026-09-16', name: 'Testfeiertag' })
      .execute();
    const base = {
      workingModel: 'salary',
      targetHoursPerWeek: 40,
      workDaysPerWeek: 5,
      contractStartDate: '2026-09-01',
    };
    const on = await mk({ ...base, firstName: 'Bonus', lastName: 'On', getsPublicHoliday: true });
    const off = await mk({ ...base, firstName: 'Bonus', lastName: 'Off', getsPublicHoliday: false });
    const idle = await mk({ ...base, firstName: 'Bonus', lastName: 'Idle', getsPublicHoliday: true });
    for (const id of [on, off]) {
      await punch(id, '2026-09-16', 8); // the holiday
      await punch(id, '2026-09-17', 8); // a normal day
    }
    const [a, b, c] = [await ledger(on), await ledger(off), await ledger(idle)];
    expect(a.body.balanceHours - b.body.balanceHours).toBe(8);
    expect(a.body.lines.find((l: any) => l.type === 'holiday_bonus')).toMatchObject({
      month: '2026-09',
      hours: 8,
    });
    expect(b.body.lines.find((l: any) => l.type === 'holiday_bonus')).toBeUndefined();
    // a holiday not worked gets no bonus (only the normal credit for salary workers)
    expect(c.body.lines.find((l: any) => l.type === 'holiday_bonus')).toBeUndefined();
    await ctx.db.deleteFrom('public_holiday').where('date', '=', '2026-09-16').execute();
  });
});

describe('overtime kept or paid out', () => {
  it('payout mode takes the monthly surplus out of the balance, account mode keeps it', async () => {
    // 10 h per week = 43.33 h per month. Six 10 h days in September: 60 h worked, 16.67 h over the target.
    const base = { workingModel: 'hourly', targetHoursPerWeek: 10, contractStartDate: '2026-09-01' };
    const keep = await mk({ ...base, firstName: 'Keep', lastName: 'Hours' });
    const pay = await mk({ ...base, firstName: 'Pay', lastName: 'Hours', overtimeMode: 'payout' });
    for (const id of [keep, pay])
      for (const d of ['01', '02', '03', '08', '09', '10']) await punch(id, `2026-09-${d}`, 10);

    const k = (await ledger(keep)).body;
    const p = (await ledger(pay)).body;
    expect(k.lines.some((l: any) => l.type === 'payout_auto')).toBe(false);
    const out = p.lines.find((l: any) => l.type === 'payout_auto');
    expect(out.month).toBe('2026-09');
    expect(out.hours).toBeCloseTo(-16.67, 1);
    // the payout is exactly what separates the two balances
    expect(k.balanceHours - p.balanceHours).toBeCloseTo(16.67, 1);
    // the lines still add up to the balance (the ledger rule)
    const sum = p.lines.reduce((a: number, l: any) => a + l.hours, 0);
    expect(sum).toBeCloseTo(p.balanceHours, 1);
    // October has no work at all: the shortfall stays for both
    expect(p.balanceHours).toBeLessThan(0);

    // payroll sees what to pay out for September, and only for the payout contract
    const payroll = await call(
      ctx,
      'GET',
      `/payroll/export?month=2026-09&hotelIds=${fx.hotelA1}&format=json`,
      fx.adminA.token,
    );
    const rowOf = (id: number) => payroll.body.rows.find((x: any) => x.employeeId === id);
    expect(rowOf(pay)).toMatchObject({ overtimeMode: 'payout' });
    expect(rowOf(pay).overtimeToPayHours).toBeCloseTo(16.67, 1);
    expect(rowOf(keep)).toMatchObject({ overtimeMode: 'account', overtimeToPayHours: null });
    const csv = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/payroll/export?month=2026-09&hotelIds=${fx.hotelA1}&format=csv&includeOpen=true`,
      headers: { authorization: `Bearer ${fx.adminA.token}` },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.split('\n')[0]).toContain('Überstunden auszuzahlen Std');
  });

  it('the hotel default applies to new employees, a contract can differ, a new version keeps the setting', async () => {
    const setDefault = (token: string, mode: string) =>
      call(ctx, 'PUT', `/hotels/${fx.hotelA1}/settings`, token, { defaultOvertimeMode: mode });
    expect((await setDefault(fx.mgrA1.token, 'payout')).status).toBe(403);
    expect((await setDefault(fx.adminB.token, 'payout')).status).toBe(403); // another company
    const set = await setDefault(fx.adminA.token, 'payout');
    expect(set.status).toBe(200);
    expect(set.body.defaultOvertimeMode).toBe('payout');
    expect((await call(ctx, 'GET', `/hotels/${fx.hotelA1}/settings`, fx.mgrA1.token)).body).toMatchObject({
      defaultOvertimeMode: 'payout',
    });

    const inherits = await mk({ firstName: 'Default', lastName: 'Payout' });
    const explicit = await mk({ firstName: 'Explicit', lastName: 'Account', overtimeMode: 'account' });
    expect((await contracts(inherits))[0].overtimeMode).toBe('payout');
    expect((await contracts(explicit))[0].overtimeMode).toBe('account');

    // a new contract version without the field keeps the setting; with the field it changes
    const next = (over: Record<string, unknown>) =>
      call(ctx, 'PUT', `/employees/${inherits}/contract`, fx.adminA.token, {
        validFrom: '2027-01-01',
        employmentType: 'full_time',
        workingModel: 'salary',
        workDaysPerWeek: 5,
        targetHoursPerWeek: 40,
        vacationDaysPerYear: 30,
        ...over,
      });
    expect((await next({})).status).toBe(200);
    expect((await contracts(inherits))[0]).toMatchObject({ validFrom: '2027-01-01', overtimeMode: 'payout' });
    expect((await next({ validFrom: '2027-02-01', overtimeMode: 'account' })).status).toBe(200);
    expect((await contracts(inherits))[0].overtimeMode).toBe('account');
    // an invalid value is refused
    expect((await next({ validFrom: '2027-03-01', overtimeMode: 'maybe' })).status).toBe(400);
  });
});

describe('planning on any day', () => {
  it('a contract with Monday to Wednesday as working days can still be planned on a Saturday', async () => {
    const id = await mk({
      firstName: 'Any',
      lastName: 'Day',
      workingWeekdays: [1, 2, 3],
      workDaysPerWeek: 3,
      contractStartDate: '2026-10-01',
    });
    const saturday = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: id,
      shiftId: fx.early,
      date: '2026-10-31',
    });
    expect(saturday.status).toBe(201);
    expect(new Date('2026-10-31T12:00:00Z').getUTCDay()).toBe(6); // it is a Saturday
  });
});

describe('weekly average over 26 weeks', () => {
  it('warns when the planned hours average more than 48 h per week, counting only the weeks employed', async () => {
    const id = await mk({
      firstName: 'Long',
      lastName: 'Weeks',
      contractStartDate: '2026-10-26',
      workDaysPerWeek: 6,
      workingWeekdays: [1, 2, 3, 4, 5, 6],
    });
    const plan = (date: string) =>
      call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
        hotelId: fx.hotelA1,
        employeeId: id,
        date,
        start: '06:00',
        end: '16:30',
        plannedBreakMinutes: 30, // 10 h of work per day
      });
    const warned: string[][] = [];
    // three weeks of six 10 h days each (Monday to Saturday)
    for (const monday of ['2026-10-26', '2026-11-02', '2026-11-09'])
      for (let d = 0; d < 6; d++) {
        const date = new Date(Date.parse(`${monday}T12:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
        const r = await plan(date);
        expect(r.status, `${date}: ${JSON.stringify(r.body)}`).toBe(201);
        warned.push((r.body.warnings ?? []).map((w: any) => w.code));
      }
    // the first four days are 10 h each: 40 h in the first week, no weekly average warning yet
    expect(warned.slice(0, 4).flat()).not.toContain('WEEKLY_AVERAGE');
    // the fifth day makes 50 h in a single week of employment: above 48 h
    expect(warned[4]).toContain('WEEKLY_AVERAGE');
    expect(warned.at(-1)).toContain('WEEKLY_AVERAGE');
    // a plan within 48 h per week stays clean
    const calm = await mk({
      firstName: 'Calm',
      lastName: 'Weeks',
      contractStartDate: '2026-10-26',
    });
    const r = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: calm,
      shiftId: fx.early,
      date: '2026-10-26',
    });
    expect((r.body.warnings ?? []).map((w: any) => w.code)).not.toContain('WEEKLY_AVERAGE');
  });
});
