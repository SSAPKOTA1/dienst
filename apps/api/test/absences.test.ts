import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, ctxHolder, planFixture, startApp, stopApp, type PlanFx, type TestCtx } from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-04T10:00:00Z') }); // Sunday 4 Oct 2026
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  // public holidays for the day counting tests
  await ctx.db
    .insertInto('public_holiday')
    .values([
      { scope: 'national', date: '2026-10-03', name: 'Tag der Deutschen Einheit' },
      { scope: 'national', date: '2026-12-25', name: '1. Weihnachtstag' },
      { scope: 'state', federal_state: 'HE', date: '2026-11-05', name: 'Landesfeiertag HE' },
    ])
    .execute();
});
afterAll(async () => stopApp(ctx));

const absence = (token: string, body: Record<string, unknown>) =>
  call(ctx, 'POST', '/schedule/absence', token, body);
const entry = (token: string, body: Record<string, unknown>) =>
  call(ctx, 'POST', '/schedule/entries', token, { hotelId: fx.hotelA1, ...body });
const allowance = async (emp: number) =>
  await ctx.db
    .selectFrom('employee_vacation_allowance')
    .selectAll()
    .where('employee_id', '=', emp)
    .where('year', '=', 2026)
    .executeTakeFirstOrThrow();

describe('vacation and day counting', () => {
  it('counts working weekdays only, skips public holidays, books the allowance and cancels entries', async () => {
    const e = await entry(fx.adminA.token, {
      employeeId: fx.emp.maria,
      shiftId: fx.early,
      date: '2026-11-04',
    });
    await call(ctx, 'POST', '/schedule/publish', fx.adminA.token, {
      hotelIds: [fx.hotelA1],
      from: '2026-11-02',
      to: '2026-11-08',
    });
    const before = await allowance(fx.emp.maria);
    // Mon 2 Nov - Sun 8 Nov: Mo-Fr = 5 days, minus Thu 5 Nov (state holiday HE) = 4
    const r = await absence(fx.mgrA1.token, {
      employeeId: fx.emp.maria,
      from: '2026-11-02',
      to: '2026-11-08',
      type: 'annual_leave',
    });
    expect(r.status).toBe(201);
    expect(r.body.days).toBe(4);
    expect(r.body.cancelledEntries).toBe(1);
    const after = await allowance(fx.emp.maria);
    expect(after.used_days - before.used_days).toBe(4);
    const row = await ctx.db
      .selectFrom('time_off')
      .selectAll()
      .where('id', '=', r.body.absenceId)
      .executeTakeFirstOrThrow();
    expect([
      row.type,
      row.status,
      row.time_off_days,
      row.counts_against_allowance,
      row.credits_hours,
    ]).toEqual(['annual_leave', 'approved', 4, true, true]);
    const sched = await ctx.db
      .selectFrom('schedule')
      .select(['status', 'cancel_reason', 'time_off_id'])
      .where('id', '=', e.body.entry.id)
      .executeTakeFirstOrThrow();
    expect(sched).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'changed',
      time_off_id: r.body.absenceId,
    });
    // planning on an absent day is blocked
    const blocked = await entry(fx.adminA.token, {
      employeeId: fx.emp.maria,
      shiftId: fx.early,
      date: '2026-11-03',
    });
    expect(blocked.body.error.details.violations.map((v: any) => v.code)).toContain('ABSENCE_CONFLICT');
    // the employee got a schedule_changed notice (the cancelled entry was published)
    const n = await ctx.db
      .selectFrom('notification')
      .select('kind')
      .where('employee_id', '=', fx.emp.maria)
      .where('kind', '=', 'schedule_changed')
      .execute();
    expect(n.length).toBeGreaterThan(0);
    // reversal restores the allowance and the entry
    const del = await call(ctx, 'DELETE', `/schedule/absence/${r.body.absenceId}`, fx.mgrA1.token);
    expect(del.status).toBe(200);
    expect(del.body.restored).toBe(1);
    expect((await allowance(fx.emp.maria)).used_days).toBe(before.used_days);
    expect(
      (
        await ctx.db
          .selectFrom('schedule')
          .select('status')
          .where('id', '=', e.body.entry.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('published');
  });

  it('exceeding the allowance needs a reason (VACATION_EXCEEDS), which is audited', async () => {
    await ctx.db
      .updateTable('employee_vacation_allowance')
      .set({ allocated_days: 3, used_days: 0 })
      .where('employee_id', '=', fx.emp.jon)
      .execute();
    const r = await absence(fx.adminA.token, {
      employeeId: fx.emp.jon,
      from: '2026-11-09',
      to: '2026-11-13',
      type: 'annual_leave',
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('REASON_REQUIRED');
    expect(r.body.error.details.violations[0].code).toBe('VACATION_EXCEEDS');
    const ok = await absence(fx.adminA.token, {
      employeeId: fx.emp.jon,
      from: '2026-11-09',
      to: '2026-11-13',
      type: 'annual_leave',
      overrideReason: 'Sonderregelung vereinbart',
    });
    expect(ok.status).toBe(201);
    const a = await ctx.db
      .selectFrom('audit_log')
      .select('reason')
      .where('action', '=', 'rule_override')
      .where('entity_type', '=', 'time_off')
      .execute();
    expect(a[0].reason).toBe('Sonderregelung vereinbart');
    expect((await allowance(fx.emp.jon)).used_days).toBe(5);
  });

  it('rejects types outside the + menu, empty ranges and overlapping absences; free days are replaced', async () => {
    expect(
      (
        await absence(fx.adminA.token, {
          employeeId: fx.emp.tom,
          from: '2026-11-16',
          to: '2026-11-16',
          type: 'maternity_leave',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await absence(fx.adminA.token, {
          employeeId: fx.emp.tom,
          from: '2026-11-21',
          to: '2026-11-22',
          type: 'annual_leave',
        })
      ).status,
    ).toBe(400); // weekend only
    expect(
      (
        await absence(fx.adminA.token, {
          employeeId: fx.emp.tom,
          from: '2026-11-18',
          to: '2026-11-17',
          type: 'sick_leave',
        })
      ).status,
    ).toBe(400);
    const free = await absence(fx.adminA.token, {
      employeeId: fx.emp.tom,
      from: '2026-11-16',
      to: '2026-11-18',
      type: 'off_day',
    });
    expect(free.status).toBe(201);
    const dup = await absence(fx.adminA.token, {
      employeeId: fx.emp.tom,
      from: '2026-11-18',
      to: '2026-11-19',
      type: 'off_day',
    });
    expect(dup.status).toBe(422); // two free-day ranges may not overlap
    const school = await absence(fx.adminA.token, {
      employeeId: fx.emp.tom,
      from: '2026-11-17',
      to: '2026-11-17',
      type: 'vocational_school',
    });
    expect(school.status).toBe(201); // replaces the free day marker for that day
    const rows = await ctx.db
      .selectFrom('time_off')
      .select(['type', 'start_date', 'end_date', 'status'])
      .where('employee_id', '=', fx.emp.tom)
      .where('status', '=', 'approved')
      .orderBy('start_date')
      .execute();
    expect(rows.map((r) => `${r.type} ${r.start_date}..${r.end_date}`)).toEqual([
      'off_day 2026-11-16..2026-11-16',
      'vocational_school 2026-11-17..2026-11-17',
      'off_day 2026-11-18..2026-11-18',
    ]);
    const overlap = await absence(fx.adminA.token, {
      employeeId: fx.emp.tom,
      from: '2026-11-17',
      to: '2026-11-17',
      type: 'sick_leave',
    });
    expect(overlap.status).toBe(422);
    expect(overlap.body.error.details.violations[0].code).toBe('ABSENCE_OVERLAP');
  });
});

describe('sick leave in the past', () => {
  it('only sick leave may be entered for past days', async () => {
    const r = await absence(fx.adminA.token, {
      employeeId: fx.emp.maria,
      from: '2026-10-02',
      to: '2026-10-02',
      type: 'annual_leave',
    });
    expect(r.status).toBe(422);
    expect(r.body.error.details.violations[0].code).toBe('PAST_DAY');
  });

  it('managers may go back sickBackdateDays (7), admins further only with a reason', async () => {
    // today = 4 Oct: 27 Sep is exactly 7 days back
    const ok = await absence(fx.mgrA1.token, {
      employeeId: fx.emp.jon,
      from: '2026-09-27',
      to: '2026-09-27',
      type: 'sick_leave',
    });
    expect(ok.status).toBe(201);
    const row = await ctx.db
      .selectFrom('time_off')
      .select(['certificate_status', 'backdate_override_reason'])
      .where('id', '=', ok.body.absenceId)
      .executeTakeFirstOrThrow();
    expect(row.certificate_status).toBe('pending');
    expect(row.backdate_override_reason).toBeNull();
    const tooFar = await absence(fx.mgrA1.token, {
      employeeId: fx.emp.jon,
      from: '2026-09-26',
      to: '2026-09-26',
      type: 'sick_leave',
    });
    expect(tooFar.status).toBe(422);
    expect(tooFar.body.error.details.violations[0].code).toBe('SICK_BACKDATE');
    const noReason = await absence(fx.adminA.token, {
      employeeId: fx.emp.jon,
      from: '2026-09-26',
      to: '2026-09-26',
      type: 'sick_leave',
    });
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    const done = await absence(fx.adminA.token, {
      employeeId: fx.emp.jon,
      from: '2026-09-26',
      to: '2026-09-26',
      type: 'sick_leave',
      reason: 'Krankmeldung nachgereicht',
    });
    expect(done.status).toBe(201);
    const stored = await ctx.db
      .selectFrom('time_off')
      .select('backdate_override_reason')
      .where('id', '=', done.body.absenceId)
      .executeTakeFirstOrThrow();
    expect(stored.backdate_override_reason).toBe('Krankmeldung nachgereicht');
  });

  it('sick leave cancels today\'s shift with reason "sick"', async () => {
    const e = await entry(fx.adminA.token, {
      employeeId: fx.emp.lena,
      shiftId: fx.early,
      date: '2026-10-05',
    });
    const r = await absence(fx.mgrA1.token, {
      employeeId: fx.emp.lena,
      from: '2026-10-05',
      to: '2026-10-06',
      type: 'sick_leave',
    });
    expect(r.status).toBe(201);
    expect(
      (
        await ctx.db
          .selectFrom('schedule')
          .select('cancel_reason')
          .where('id', '=', e.body.entry.id)
          .executeTakeFirstOrThrow()
      ).cancel_reason,
    ).toBe('sick');
  });

  it('PUNCH_EXISTS blocks an absence on a day with a time record; closed periods block too', async () => {
    await ctx.db
      .insertInto('punch_record')
      .values({
        employee_id: fx.emp.piotr,
        hotel_id: fx.hotelA1,
        shift_date: '2026-10-01',
        actual_punch_in: new Date('2026-10-01T06:00:00Z'),
        actual_punch_out: new Date('2026-10-01T14:00:00Z'),
      })
      .execute();
    const r = await absence(fx.adminA.token, {
      employeeId: fx.emp.piotr,
      from: '2026-10-01',
      to: '2026-10-02',
      type: 'sick_leave',
      reason: 'nachgetragen',
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PUNCH_EXISTS');
    await ctx.db
      .insertInto('payroll_period')
      .values({
        company_id: fx.companyA,
        period_start: '2026-12-01',
        period_end: '2026-12-31',
        status: 'closed',
      })
      .execute();
    const c = await absence(fx.adminA.token, {
      employeeId: fx.emp.maria,
      from: '2026-12-07',
      to: '2026-12-08',
      type: 'annual_leave',
    });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('PERIOD_CLOSED');
    await ctx.db.deleteFrom('payroll_period').execute();
  });

  it('scope: a manager cannot mark absences for employees of other hotels; admins of other companies neither', async () => {
    expect(
      (
        await absence(fx.mgrA2.token, {
          employeeId: fx.emp.maria,
          from: '2026-12-14',
          to: '2026-12-14',
          type: 'off_day',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await absence(fx.adminB.token, {
          employeeId: fx.emp.maria,
          from: '2026-12-14',
          to: '2026-12-14',
          type: 'off_day',
        })
      ).status,
    ).toBe(403);
    // Tom works at A1 and A2: the manager of A2 may mark him
    expect(
      (
        await absence(fx.mgrA2.token, {
          employeeId: fx.emp.tom,
          from: '2026-12-14',
          to: '2026-12-14',
          type: 'off_day',
        })
      ).status,
    ).toBe(201);
  });
});
