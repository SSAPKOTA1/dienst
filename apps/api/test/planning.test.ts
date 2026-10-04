import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, ctxHolder, planFixture, startApp, stopApp, type PlanFx, type TestCtx } from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-04T10:00:00Z') }); // Sunday 12:00 local
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
});
afterAll(async () => stopApp(ctx));

const D = (n: number) => new Date(Date.UTC(2026, 9, 12 + n)).toISOString().slice(0, 10); // 12 Oct 2026 is a Monday
const create = (token: string, body: Record<string, unknown>) =>
  call(ctx, 'POST', '/schedule/entries', token, { hotelId: fx.hotelA1, ...body });
const codes = (r: any) => (r.body.error?.details?.violations ?? []).map((v: any) => v.code);
const del = (token: string, id: number) => call(ctx, 'DELETE', `/schedule/entries/${id}`, token);

describe('creating entries', () => {
  it('creates a draft from a shift template with UTC timestamps, version 1 and an audit row', async () => {
    const r = await create(fx.mgrA1.token, { employeeId: fx.emp.maria, shiftId: fx.early, date: D(0) });
    expect(r.status).toBe(201);
    const row = await ctx.db
      .selectFrom('schedule')
      .selectAll()
      .where('id', '=', r.body.entry.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('draft');
    expect(row.version).toBe(1);
    expect(row.planned_start.toISOString()).toBe('2026-10-12T04:00:00.000Z'); // 06:00 CEST
    expect(row.planned_end.toISOString()).toBe('2026-10-12T12:00:00.000Z');
    expect(row.planned_break_minutes).toBe(30);
    expect(row.shift_date).toBe(D(0));
    expect(row.created_by_role).toBe('manager');
    const a = await ctx.db
      .selectFrom('audit_log')
      .select('action')
      .where('entity_id', '=', row.id)
      .where('action', '=', 'schedule_entry_created')
      .execute();
    expect(a).toHaveLength(1);
    await del(fx.mgrA1.token, row.id);
  });

  it('ad-hoc entries default the break to the legal minimum; an end before the start means next day; DST uses real durations', async () => {
    const r = await create(fx.adminA.token, {
      employeeId: fx.emp.jon,
      date: D(0),
      start: '08:00',
      end: '16:00',
    });
    expect(r.status).toBe(201);
    const row = await ctx.db
      .selectFrom('schedule')
      .selectAll()
      .where('id', '=', r.body.entry.id)
      .executeTakeFirstOrThrow();
    expect(row.planned_break_minutes).toBe(30); // 8 h gross
    const n = await create(fx.adminA.token, {
      employeeId: fx.emp.maria,
      shiftId: fx.night,
      date: '2026-10-24',
    }); // night into the clock change
    expect(n.status).toBe(201);
    const nr = await ctx.db
      .selectFrom('schedule')
      .selectAll()
      .where('id', '=', n.body.entry.id)
      .executeTakeFirstOrThrow();
    expect((nr.planned_end.getTime() - nr.planned_start.getTime()) / 60000).toBe(540); // 22:00 CEST -> 06:00 CET
    expect(nr.shift_date).toBe('2026-10-24');
    await del(fx.adminA.token, row.id);
    await del(fx.adminA.token, nr.id);
  });

  it('validates input and scope', async () => {
    expect((await create(fx.adminA.token, { employeeId: fx.emp.maria, date: D(0) })).status).toBe(400); // no times, no shift
    expect(
      (await create(fx.adminA.token, { employeeId: fx.emp.maria, shiftId: fx.early2, date: D(0) })).status,
    ).toBe(400); // shift of another hotel
    expect(
      (await create(fx.mgrA2.token, { employeeId: fx.emp.maria, shiftId: fx.early, date: D(0) })).status,
    ).toBe(403);
    expect(
      (await create(fx.adminB.token, { employeeId: fx.emp.maria, shiftId: fx.early, date: D(0) })).status,
    ).toBe(403);
    const foreign = await call(ctx, 'POST', '/schedule/entries', fx.adminB.token, {
      hotelId: fx.hotelB1,
      employeeId: fx.emp.maria,
      date: D(0),
      start: '08:00',
      end: '12:00',
    });
    expect(foreign.status).toBe(404); // employee of another company is invisible
  });
});

describe('rules', () => {
  it('overlap is blocked across hotels; split shifts on one day are allowed', async () => {
    const a = await create(fx.adminA.token, {
      employeeId: fx.emp.tom,
      date: D(1),
      start: '08:00',
      end: '14:00',
    });
    expect(a.status).toBe(201);
    const clash = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA2,
      employeeId: fx.emp.tom,
      shiftId: fx.early2,
      date: D(1),
    });
    expect(clash.status).toBe(422);
    expect(clash.body.error.code).toBe('RULE_BLOCKED');
    expect(codes(clash)).toContain('OVERLAP');
    const split1 = await create(fx.adminA.token, {
      employeeId: fx.emp.maria,
      date: D(2),
      start: '06:00',
      end: '10:00',
    });
    const split2 = await create(fx.adminA.token, {
      employeeId: fx.emp.maria,
      date: D(2),
      start: '17:00',
      end: '21:00',
    });
    expect(split1.status).toBe(201);
    expect(split2.status).toBe(201);
  });

  it('rest period: < 10 h blocked, 10-11 h needs a reason (audited), >= 11 h ok', async () => {
    await create(fx.adminA.token, { employeeId: fx.emp.jon, shiftId: fx.late, date: D(3) }); // ends 22:00
    const blocked = await create(fx.adminA.token, { employeeId: fx.emp.jon, shiftId: fx.early, date: D(4) }); // 8 h gap
    expect(blocked.status).toBe(422);
    expect(codes(blocked)).toEqual(['REST_PERIOD']);
    expect(blocked.body.error.details.violations[0].details.gapMinutes).toBe(480);
    const needs = await create(fx.adminA.token, {
      employeeId: fx.emp.jon,
      date: D(4),
      start: '08:00',
      end: '12:00',
    }); // 10 h gap
    expect(needs.status).toBe(422);
    expect(needs.body.error.code).toBe('REASON_REQUIRED');
    const ok = await create(fx.mgrA1.token, {
      employeeId: fx.emp.jon,
      date: D(4),
      start: '08:00',
      end: '12:00',
      overrideReason: 'Vertretung wegen Krankheit',
    });
    expect(ok.status).toBe(201);
    const audit = await ctx.db
      .selectFrom('audit_log')
      .select(['reason', 'new_values'])
      .where('action', '=', 'rule_override')
      .execute();
    expect(
      audit.some(
        (a) =>
          a.reason === 'Vertretung wegen Krankheit' && JSON.stringify(a.new_values).includes('REST_PERIOD'),
      ),
    ).toBe(true);
    const fine = await create(fx.adminA.token, {
      employeeId: fx.emp.jon,
      date: D(5),
      start: '09:00',
      end: '12:00',
    }); // 11+ h after D4 12:00
    expect(fine.status).toBe(201);
  });

  it('daily limit: warning above 8 h, blocked above 10 h, emergency override only for admins with a reason', async () => {
    const warn = await create(fx.adminA.token, {
      employeeId: fx.emp.maria,
      date: D(0),
      start: '06:00',
      end: '16:00',
    }); // 9.25 h
    expect(warn.status).toBe(201);
    expect(warn.body.warnings.map((w: any) => w.code)).toEqual(['DAILY_OVER_8H']);
    await del(fx.adminA.token, warn.body.entry.id);
    const long = { employeeId: fx.emp.maria, date: D(0), start: '06:00', end: '18:00' }; // 11.25 h
    const b = await create(fx.adminA.token, long);
    expect(b.status).toBe(422);
    expect(codes(b)).toContain('DAILY_LIMIT');
    expect(
      codes(
        await create(fx.mgrA1.token, {
          ...long,
          emergencyOverride: true,
          overrideReason: 'Notfall bei Ausfall',
        }),
      ),
    ).toContain('DAILY_LIMIT'); // managers cannot
    const noReason = await create(fx.adminA.token, { ...long, emergencyOverride: true });
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    const done = await create(fx.adminA.token, {
      ...long,
      emergencyOverride: true,
      overrideReason: 'Notfall bei Ausfall',
    });
    expect(done.status).toBe(201);
    const aud = await ctx.db
      .selectFrom('audit_log')
      .select('new_values')
      .where('action', '=', 'rule_override')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(aud.new_values)).toContain('DAILY_LIMIT');
    await del(fx.adminA.token, done.body.entry.id);
  });

  it('minors: night window and 8 h day are hard blocks; 12 h rest can only be overridden by an admin', async () => {
    const night = await create(fx.adminA.token, {
      employeeId: fx.emp.lena,
      date: D(1),
      start: '18:00',
      end: '21:00',
    });
    expect(codes(night)).toContain('MINOR_NIGHT');
    expect(
      codes(
        await create(fx.adminA.token, {
          employeeId: fx.emp.lena,
          date: D(1),
          start: '18:00',
          end: '21:00',
          emergencyOverride: true,
          overrideReason: 'ganz dringend nötig',
        }),
      ),
    ).toContain('MINOR_NIGHT');
    expect(
      codes(
        await create(fx.adminA.token, { employeeId: fx.emp.lena, date: D(1), start: '06:00', end: '16:00' }),
      ),
    ).toContain('MINOR_DAILY');
    await create(fx.adminA.token, { employeeId: fx.emp.lena, shiftId: fx.early, date: D(2) }); // 06-14
    const rest = { employeeId: fx.emp.lena, date: D(3), start: '07:00', end: '12:00' }; // 17 h gap is fine
    expect((await create(fx.adminA.token, rest)).status).toBe(201);
    const tight = { employeeId: fx.emp.lena, date: D(4), start: '06:00', end: '11:00' }; // 18 h after D3 12:00? -> 18h fine
    expect((await create(fx.adminA.token, tight)).status).toBe(201);
    // 11 h rest: ok for adults, MINOR_REST for the 17-year-old
    await create(fx.adminA.token, { employeeId: fx.emp.lena, date: D(5), start: '12:00', end: '19:00' });
    const elevenH = { employeeId: fx.emp.lena, date: D(6), start: '06:00', end: '09:00' }; // gap 11 h
    const m = await create(fx.mgrA1.token, {
      ...elevenH,
      emergencyOverride: true,
      overrideReason: 'Vertretung im Notfall',
    });
    expect(codes(m)).toContain('MINOR_REST');
    expect(codes(await create(fx.adminA.token, elevenH))).toContain('MINOR_REST');
    expect((await create(fx.adminA.token, { ...elevenH, emergencyOverride: true })).body.error.code).toBe(
      'REASON_REQUIRED',
    );
    const ov = await create(fx.adminA.token, {
      ...elevenH,
      emergencyOverride: true,
      overrideReason: 'Vertretung im Notfall',
    });
    expect(ov.status).toBe(201);
  });

  it('past days, closed periods, hotel / department membership, inactive contracts and monthly caps', async () => {
    expect(
      codes(
        await create(fx.adminA.token, { employeeId: fx.emp.maria, shiftId: fx.early, date: '2026-10-02' }),
      ),
    ).toEqual(['PAST_DAY']);
    expect(
      (await create(fx.adminA.token, { employeeId: fx.emp.maria, shiftId: fx.early, date: '2026-10-04' }))
        .status,
    ).toBe(201); // today is allowed
    // membership
    expect(
      codes(await create(fx.adminA.token, { employeeId: fx.emp.piotr, shiftId: fx.early, date: D(7) })),
    ).toEqual(['WRONG_DEPARTMENT']);
    expect(
      codes(
        await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
          hotelId: fx.hotelA2,
          employeeId: fx.emp.maria,
          shiftId: fx.early2,
          date: D(7),
        }),
      ),
    ).toEqual(['NOT_AT_HOTEL', 'WRONG_DEPARTMENT']);
    // contract ended
    await ctx.db
      .updateTable('employee_contract')
      .set({ valid_to: '2026-10-31' })
      .where('employee_id', '=', fx.emp.piotr)
      .execute();
    expect(
      codes(await create(fx.adminA.token, { employeeId: fx.emp.piotr, shiftId: fx.hk, date: '2026-11-03' })),
    ).toEqual(['CONTRACT_INACTIVE']);
    // closed period -> 409
    await ctx.db
      .insertInto('payroll_period')
      .values({
        company_id: fx.companyA,
        period_start: '2026-11-01',
        period_end: '2026-11-30',
        status: 'closed',
      })
      .execute();
    const closed = await create(fx.adminA.token, {
      employeeId: fx.emp.maria,
      shiftId: fx.early,
      date: '2026-11-03',
    });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('PERIOD_CLOSED');
    await ctx.db.deleteFrom('payroll_period').execute();
    // monthly cap is a warning
    const cap = await create(fx.adminA.token, { employeeId: fx.emp.cap, shiftId: fx.early, date: D(0) });
    const cap2 = await create(fx.adminA.token, { employeeId: fx.emp.cap, shiftId: fx.early, date: D(1) });
    const cap3 = await create(fx.adminA.token, { employeeId: fx.emp.cap, shiftId: fx.early, date: D(2) });
    expect(cap.status).toBe(201);
    expect(cap2.body.warnings).toEqual([]);
    expect(cap3.body.warnings.map((w: any) => w.code)).toEqual(['MONTHLY_CAP']);
  });
});

describe('updating, locking and dry runs', () => {
  it('optimistic locking: stale versions get 409 VERSION_CONFLICT, versions increase', async () => {
    const e = await create(fx.adminA.token, { employeeId: fx.emp.maria, shiftId: fx.early, date: D(8) });
    const id = e.body.entry.id;
    const u1 = await call(ctx, 'PUT', `/schedule/entries/${id}`, fx.mgrA1.token, {
      version: 1,
      start: '09:00',
      end: '17:00',
    });
    expect(u1.status).toBe(200);
    expect(u1.body.entry.version).toBe(2);
    const stale = await call(ctx, 'PUT', `/schedule/entries/${id}`, fx.adminA.token, {
      version: 1,
      start: '10:00',
      end: '18:00',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect((await call(ctx, 'DELETE', `/schedule/entries/${id}?version=1`, fx.adminA.token)).status).toBe(
      409,
    );
    expect((await call(ctx, 'DELETE', `/schedule/entries/${id}?version=2`, fx.adminA.token)).status).toBe(
      200,
    );
    expect(
      await ctx.db.selectFrom('schedule').select('id').where('id', '=', id).executeTakeFirst(),
    ).toBeUndefined();
  });

  it('validate is a dry run that agrees with the real write and returns new totals', async () => {
    const before = await ctx.db
      .selectFrom('schedule')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    const body = {
      operation: 'create',
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.early,
      date: D(10),
    };
    const v = await call(ctx, 'POST', '/schedule/validate', fx.mgrA1.token, body);
    expect(v.status).toBe(200);
    expect(v.body.status).toBe('ok');
    expect(v.body.totals[0]).toMatchObject({ employeeId: fx.emp.jon, weekHours: 7.5 });
    const after = await ctx.db
      .selectFrom('schedule')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
    const bad = await call(ctx, 'POST', '/schedule/validate', fx.mgrA1.token, {
      ...body,
      date: '2026-10-01',
    });
    expect(bad.body.status).toBe('blocked');
    expect(bad.body.violations[0].code).toBe('PAST_DAY');
    await create(fx.adminA.token, { employeeId: fx.emp.maria, shiftId: fx.late, date: D(26) });
    const needs = await call(ctx, 'POST', '/schedule/validate', fx.mgrA1.token, {
      operation: 'create',
      hotelId: fx.hotelA1,
      employeeId: fx.emp.maria,
      date: D(27),
      start: '08:00',
      end: '12:00',
    });
    expect(needs.body.status).toBe('needs_reason');
  });
});

describe('move, copy, swap, bulk', () => {
  it('moves an entry to another employee/day, keeping the time of day; copy creates a new draft', async () => {
    const e = await create(fx.adminA.token, { employeeId: fx.emp.maria, shiftId: fx.early, date: D(14) });
    const m = await call(ctx, 'POST', '/schedule/move', fx.adminA.token, {
      entryId: e.body.entry.id,
      version: 1,
      toEmployeeId: fx.emp.jon,
      toDate: D(15),
    });
    expect(m.status).toBe(200);
    const row = await ctx.db
      .selectFrom('schedule')
      .selectAll()
      .where('id', '=', e.body.entry.id)
      .executeTakeFirstOrThrow();
    expect([row.employee_id, row.shift_date, row.version]).toEqual([fx.emp.jon, D(15), 2]);
    expect(row.planned_start.toISOString()).toBe('2026-10-27T05:00:00.000Z'); // 06:00 CET after the clock change
    const c = await call(ctx, 'POST', '/schedule/copy', fx.adminA.token, {
      entryId: e.body.entry.id,
      toEmployeeId: fx.emp.maria,
      toDate: D(15),
    });
    expect(c.status).toBe(201);
    expect(c.body.entry.id).not.toBe(e.body.entry.id);
    expect(c.body.entry.status).toBe('draft');
  });

  it('swap exchanges the slots of two entries atomically, even when they overlap in time', async () => {
    const a = await create(fx.adminA.token, { employeeId: fx.emp.maria, shiftId: fx.early, date: D(20) });
    const b = await create(fx.adminA.token, { employeeId: fx.emp.jon, shiftId: fx.late, date: D(20) });
    const s = await call(ctx, 'POST', '/schedule/swap', fx.adminA.token, {
      entryAId: a.body.entry.id,
      versionA: 1,
      entryBId: b.body.entry.id,
      versionB: 1,
    });
    expect(s.status).toBe(200);
    const ra = await ctx.db
      .selectFrom('schedule')
      .select(['employee_id', 'shift_date'])
      .where('id', '=', a.body.entry.id)
      .executeTakeFirstOrThrow();
    const rb = await ctx.db
      .selectFrom('schedule')
      .select(['employee_id', 'shift_date'])
      .where('id', '=', b.body.entry.id)
      .executeTakeFirstOrThrow();
    expect(ra.employee_id).toBe(fx.emp.jon);
    expect(rb.employee_id).toBe(fx.emp.maria);
    // a swap that breaks a rule changes nothing: Lena (minor) cannot take the late shift
    const l = await create(fx.adminA.token, { employeeId: fx.emp.lena, shiftId: fx.early, date: D(21) });
    const j = await create(fx.adminA.token, { employeeId: fx.emp.jon, shiftId: fx.late, date: D(21) });
    const bad = await call(ctx, 'POST', '/schedule/swap', fx.adminA.token, {
      entryAId: l.body.entry.id,
      versionA: 1,
      entryBId: j.body.entry.id,
      versionB: 1,
    });
    expect(bad.status).toBe(422);
    const unchanged = await ctx.db
      .selectFrom('schedule')
      .select('employee_id')
      .where('id', '=', l.body.entry.id)
      .executeTakeFirstOrThrow();
    expect(unchanged.employee_id).toBe(fx.emp.lena);
  });

  it('bulk is all-or-nothing', async () => {
    const ops = [
      { op: 'create', hotelId: fx.hotelA1, employeeId: fx.emp.maria, shiftId: fx.early, date: D(25) },
      { op: 'create', hotelId: fx.hotelA1, employeeId: fx.emp.jon, shiftId: fx.early, date: D(25) },
      {
        op: 'create',
        hotelId: fx.hotelA1,
        employeeId: fx.emp.maria,
        date: D(25),
        start: '16:00',
        end: '18:00',
      }, // split shift, 9.5 h in total: a warning only
      {
        op: 'create',
        hotelId: fx.hotelA1,
        employeeId: fx.emp.maria,
        date: D(25),
        start: '07:00',
        end: '09:00',
      }, // overlaps the first
    ];
    const r = await call(ctx, 'POST', '/schedule/bulk', fx.adminA.token, { operations: ops });
    expect(r.status).toBe(422);
    expect(r.body.error.details.operationIndex).toBe(3);
    const n = await ctx.db.selectFrom('schedule').select('id').where('shift_date', '=', D(25)).execute();
    expect(n).toHaveLength(0);
    const ok = await call(ctx, 'POST', '/schedule/bulk', fx.adminA.token, { operations: ops.slice(0, 3) });
    expect(ok.status).toBe(200);
    expect(ok.body.results).toHaveLength(3);
  });
});
