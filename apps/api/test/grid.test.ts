import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, ctxHolder, planFixture, startApp, stopApp, type PlanFx, type TestCtx } from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-04T10:00:00Z') });
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  await call(ctx, 'PUT', `/shifts/${fx.early}/staffing`, fx.adminA.token, {
    weekdayDefaults: { '1': 3, '2': 3, '3': 3, '4': 3, '5': 3, '6': 1, '7': 1 },
  });
  await call(ctx, 'PUT', `/shifts/${fx.late}/staffing`, fx.adminA.token, { weekdayDefaults: { '1': 1 } });
  await ctx.db
    .insertInto('public_holiday')
    .values({ scope: 'national', date: '2026-10-14', name: 'Testfeiertag' })
    .execute();
});
afterAll(async () => stopApp(ctx));

const W = '2026-10-12';
const entry = (body: Record<string, unknown>) =>
  call(ctx, 'POST', '/schedule/entries', fx.adminA.token, { hotelId: fx.hotelA1, ...body });
const grid = (token: string, q: string) => call(ctx, 'GET', `/schedule/grid?${q}`, token);

describe('planning grid', () => {
  beforeAll(async () => {
    await entry({ employeeId: fx.emp.maria, shiftId: fx.early, date: '2026-10-12' }); // 7.5
    await entry({ employeeId: fx.emp.maria, shiftId: fx.early, date: '2026-10-13' }); // 7.5
    await entry({ employeeId: fx.emp.jon, shiftId: fx.early, date: '2026-10-12' });
    await entry({ employeeId: fx.emp.lena, shiftId: fx.late, date: '2026-10-12' }); // minor late shift: MINOR_NIGHT (till 22:00)? 14-22 overlaps 20-06 -> blocked at create
    await entry({ employeeId: fx.emp.tom, shiftId: fx.early, date: '2026-10-12' });
    await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
      employeeId: fx.emp.jon,
      from: '2026-10-15',
      to: '2026-10-16',
      type: 'annual_leave',
    });
  });

  it('employee view: totals against the weekly target, credit hours for absences, flags and absences', async () => {
    const r = await grid(fx.adminA.token, `hotelIds=${fx.hotelA1}&view=employee&range=week&from=2026-10-14`);
    expect(r.status).toBe(200);
    expect(r.body.from).toBe(W);
    expect(r.body.to).toBe('2026-10-18');
    expect(r.body.days).toHaveLength(7);
    expect(r.body.days[2]).toMatchObject({ date: '2026-10-14', holiday: 'Testfeiertag' });
    const maria = r.body.rows.find((x: any) => x.employeeId === fx.emp.maria);
    expect(maria).toMatchObject({
      key: `emp:${fx.emp.maria}`,
      totalHours: 15,
      targetHours: 40,
      creditHours: 0,
    });
    expect(maria.cells[0].entries[0]).toMatchObject({
      hours: 7.5,
      status: 'draft',
      change: 'new',
      employeeId: fx.emp.maria,
    });
    expect(maria.cells[0].entries[0].start).toBe('2026-10-12T06:00:00+02:00');
    const jon = r.body.rows.find((x: any) => x.employeeId === fx.emp.jon);
    expect(jon.creditHours).toBe(16); // two vacation days x 8 h daily target
    expect(jon.cells[3].absenceIds).toHaveLength(1);
    expect(r.body.absences[0]).toMatchObject({
      type: 'annual_leave',
      from: '2026-10-15',
      to: '2026-10-16',
      status: 'approved',
    });
    const lena = r.body.rows.find((x: any) => x.employeeId === fx.emp.lena);
    expect(lena.isMinor).toBe(true);
    expect(r.body.counts.drafts).toBe(4);
    expect(r.body.status).toBe('draft');
    expect(r.body.totals.perDay[0]).toMatchObject({ date: W, hours: 22.5, headcount: 3 });
  });

  it('shift view: required, assigned and open slots per cell and totals per shift', async () => {
    const r = await grid(fx.mgrA1.token, `hotelIds=${fx.hotelA1}&view=shift&from=${W}`);
    const early = r.body.rows.find((x: any) => x.shiftId === fx.early);
    expect(early.cells[0]).toMatchObject({ date: W, required: 3, assigned: 3, open: 0 });
    expect(early.cells[1]).toMatchObject({ required: 3, assigned: 1, open: 2 });
    expect(early.cells[5]).toMatchObject({ required: 1, assigned: 0, open: 1 });
    expect(early.totalHours).toBe(30); // 4 entries x 7.5
    expect(early.openSlots).toBe(0 + 2 + 3 + 3 + 3 + 1 + 1);
    const late = r.body.rows.find((x: any) => x.shiftId === fx.late);
    expect(late.cells[0]).toMatchObject({ required: 1 });
  });

  it('coverage per department and day, understaffed counter', async () => {
    const r = await grid(fx.mgrA1.token, `hotelIds=${fx.hotelA1}&view=shift&from=${W}`);
    const rez = r.body.coverage.filter((c: any) => c.departmentId === fx.deptA1);
    expect(rez[0]).toMatchObject({ date: W, assigned: 3, required: 4, underStaffed: true }); // early 3 + late 1 required
    expect(rez[1]).toMatchObject({ assigned: 1, required: 3, underStaffed: true });
    expect(r.body.counts.underStaffed).toBeGreaterThan(5);
    const dep = await grid(
      fx.mgrA1.token,
      `hotelIds=${fx.hotelA1}&view=shift&from=${W}&departmentIds=${fx.deptA1b}`,
    );
    expect(dep.body.rows.every((x: any) => x.departmentId === fx.deptA1b)).toBe(true);
  });

  it('warnings of existing entries come from the server rules', async () => {
    // seed a rest-period problem directly (it would be blocked through the API): Maria late Monday, early Tuesday -> 8 h
    await ctx.db
      .insertInto('schedule')
      .values({
        hotel_id: fx.hotelA1,
        employee_id: fx.emp.piotr,
        shift_id: null,
        shift_date: '2026-10-19',
        planned_start: new Date('2026-10-19T12:00:00Z'),
        planned_end: new Date('2026-10-19T20:00:00Z'),
        planned_break_minutes: 30,
        status: 'draft',
        created_by_user_id: fx.adminA.userId,
        created_by_role: 'admin',
      })
      .execute();
    await ctx.db
      .insertInto('schedule')
      .values({
        hotel_id: fx.hotelA1,
        employee_id: fx.emp.piotr,
        shift_id: null,
        shift_date: '2026-10-20',
        planned_start: new Date('2026-10-20T04:00:00Z'),
        planned_end: new Date('2026-10-20T10:00:00Z'),
        planned_break_minutes: 0,
        status: 'draft',
        created_by_user_id: fx.adminA.userId,
        created_by_role: 'admin',
      })
      .execute();
    const r = await grid(fx.adminA.token, `hotelIds=${fx.hotelA1}&view=employee&from=2026-10-19`);
    const piotr = r.body.rows.find((x: any) => x.employeeId === fx.emp.piotr);
    const w = piotr.cells
      .flatMap((c: any) => c.entries)
      .flatMap((e: any) => e.warnings.map((x: any) => x.code));
    expect(w).toContain('REST_PERIOD');
    expect(r.body.counts.warnings).toBe(2);
  });

  it('locked days: past days and closed periods are reported', async () => {
    const r = await grid(fx.adminA.token, `hotelIds=${fx.hotelA1}&view=employee&from=2026-09-28`);
    expect(r.body.days.slice(0, 7).every((d: any) => d.past === d.date < '2026-10-04')).toBe(true);
    expect(r.body.rows[0].cells[0].locked).toBe('past');
    await ctx.db
      .insertInto('payroll_period')
      .values({
        company_id: fx.companyA,
        period_start: '2026-12-01',
        period_end: '2026-12-31',
        status: 'closed',
      })
      .execute();
    const c = await grid(fx.adminA.token, `hotelIds=${fx.hotelA1}&view=employee&from=2026-12-07`);
    expect(c.body.days[0].closedHotelIds).toEqual([fx.hotelA1]);
    expect(c.body.rows[0].cells[0].locked).toBe('closed');
    await ctx.db.deleteFrom('payroll_period').execute();
  });

  it('month range covers the calendar month with the monthly target', async () => {
    const r = await grid(fx.adminA.token, `hotelIds=${fx.hotelA1}&view=employee&range=month&from=2026-10-20`);
    expect(r.body.from).toBe('2026-10-01');
    expect(r.body.to).toBe('2026-10-31');
    expect(r.body.days).toHaveLength(31);
    const maria = r.body.rows.find((x: any) => x.employeeId === fx.emp.maria);
    expect(maria.targetHours).toBe(173.3);
  });

  it('multi-hotel view: floaters of another hotel are marked; scope is enforced', async () => {
    // Tom (A1 + A2) works at A2 on Tuesday
    await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA2,
      employeeId: fx.emp.tom,
      shiftId: fx.early2,
      date: '2026-10-13',
    });
    const a1 = await grid(fx.mgrA1.token, `hotelIds=${fx.hotelA1}&view=employee&from=${W}`);
    const tom = a1.body.rows.find((x: any) => x.employeeId === fx.emp.tom);
    const other = tom.cells[1].entries.find((e: any) => e.isOtherHotel);
    expect(other).toMatchObject({ otherHotelName: 'A2 Berlin', readOnly: true });
    const both = await grid(fx.adminA.token, `hotelIds=${fx.hotelA1},${fx.hotelA2}&view=employee&from=${W}`);
    const tom2 = both.body.rows.filter((x: any) => x.employeeId === fx.emp.tom);
    expect(tom2).toHaveLength(1);
    expect(tom2[0].cells[1].entries.some((e: any) => e.isOtherHotel)).toBe(false);
    expect((await grid(fx.mgrA1.token, `hotelIds=${fx.hotelA2}&view=employee&from=${W}`)).status).toBe(403);
    expect((await grid(fx.adminB.token, `hotelIds=${fx.hotelA1}&view=employee&from=${W}`)).status).toBe(403);
  });

  it('managers of other hotels see the reduced view: no personnel number or target, absences as "absent"', async () => {
    const r = await grid(fx.mgrA2.token, `hotelIds=${fx.hotelA2}&view=employee&from=${W}`);
    const tom = r.body.rows.find((x: any) => x.employeeId === fx.emp.tom);
    expect(tom.reduced).toBe(true); // Tom's home hotel is A1
    expect(tom.targetHours).toBeNull();
    expect(tom.personnelNumber).toBeNull();
    await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
      employeeId: fx.emp.tom,
      from: '2026-10-21',
      to: '2026-10-21',
      type: 'sick_leave',
      certificateStatus: 'pending',
    });
    await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
      employeeId: fx.emp.tom,
      from: '2026-10-22',
      to: '2026-10-22',
      type: 'unpaid_leave',
    });
    const r2 = await grid(fx.mgrA2.token, `hotelIds=${fx.hotelA2}&view=employee&from=2026-10-19`);
    expect(r2.body.absences.filter((a: any) => a.employeeId === fx.emp.tom).map((a: any) => a.type)).toEqual([
      'absent',
      'absent',
    ]);
    const home = await grid(fx.mgrA1.token, `hotelIds=${fx.hotelA1}&view=employee&from=2026-10-19`);
    expect(
      home.body.absences
        .filter((a: any) => a.employeeId === fx.emp.tom)
        .map((a: any) => a.type)
        .sort(),
    ).toEqual(['sick_leave', 'unpaid_leave']);
  });
});
