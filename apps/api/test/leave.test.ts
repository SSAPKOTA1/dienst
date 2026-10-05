import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { carryOver, forfeitCarryover, sendNotices } from '../src/services/vacationJobs';
import {
  call,
  ctxHolder,
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
  emp = await employeeTokens(ctx, fx, ['maria', 'jon', 'tom']);
});
afterAll(async () => stopApp(ctx));

describe('blackout periods', () => {
  it('are managed by planners of the hotel only', async () => {
    const body = {
      hotelId: fx.hotelA1,
      from: '2026-12-21',
      to: '2026-12-31',
      reason: 'Christmas',
      maxConcurrentAbsent: null,
    };
    expect((await call(ctx, 'POST', '/blackouts', emp.maria!, body)).status).toBe(403);
    expect((await call(ctx, 'POST', '/blackouts', fx.mgrA2.token, body)).status).toBe(403);
    expect((await call(ctx, 'POST', '/blackouts', fx.adminB.token, body)).status).toBe(403);
    const ok = await call(ctx, 'POST', '/blackouts', fx.mgrA1.token, body);
    expect(ok.status).toBe(201);
    expect(
      (await call(ctx, 'POST', '/blackouts', fx.mgrA1.token, { ...body, to: '2026-12-01' })).status,
    ).toBe(400);
    expect(
      (await call(ctx, 'POST', '/blackouts', fx.mgrA1.token, { ...body, departmentId: fx.deptA2 })).status,
    ).toBe(400);
    const list = await call(ctx, 'GET', `/blackouts?hotelIds=${fx.hotelA1}`, fx.mgrA1.token);
    expect(list.body.items).toHaveLength(1);
    const upd = await call(ctx, 'PUT', `/blackouts/${ok.body.id}`, fx.mgrA1.token, {
      ...body,
      reason: 'Xmas',
    });
    expect(upd.body.reason).toBe('Xmas');
    expect(
      (await call(ctx, 'GET', '/me/blackouts?from=2026-12-01&to=2026-12-31', emp.maria!)).body.items,
    ).toHaveLength(1);
    const del = await call(ctx, 'POST', '/blackouts', fx.mgrA1.token, {
      ...body,
      from: '2027-05-01',
      to: '2027-05-02',
    });
    expect((await call(ctx, 'DELETE', `/blackouts/${del.body.id}`, fx.mgrA1.token)).status).toBe(204);
  });

  it('block employee requests, need a reason from planners and show up as conflicts in the inbox', async () => {
    const r = await call(ctx, 'POST', '/me/time-off-requests', emp.maria!, {
      from: '2026-12-22',
      to: '2026-12-23',
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('RULE_BLOCKED');
    expect(r.body.error.details.violations[0]).toMatchObject({ code: 'BLACKOUT', severity: 'block' });
    const prev = await call(
      ctx,
      'GET',
      '/me/time-off-requests/preview?from=2026-12-22&to=2026-12-23',
      emp.maria!,
    );
    expect(prev.body.issues[0].code).toBe('BLACKOUT');
    // planner: reason required, then it works and is audited
    const abs = { employeeId: fx.emp.maria, from: '2026-12-22', to: '2026-12-22', type: 'annual_leave' };
    const need = await call(ctx, 'POST', '/schedule/absence', fx.mgrA1.token, abs);
    expect(need.status).toBe(422);
    expect(need.body.error.code).toBe('REASON_REQUIRED');
    expect(
      (
        await call(ctx, 'POST', '/schedule/absence', fx.mgrA1.token, {
          ...abs,
          overrideReason: 'Operations agreed',
        })
      ).status,
    ).toBe(201);
  });

  it('cap the number of colleagues who are absent at the same time', async () => {
    await call(ctx, 'POST', '/blackouts', fx.adminA.token, {
      hotelId: fx.hotelA1,
      departmentId: fx.deptA1,
      from: '2027-02-01',
      to: '2027-02-28',
      reason: 'Fair',
      maxConcurrentAbsent: 1,
    });
    const first = await call(ctx, 'POST', '/me/time-off-requests', emp.jon!, {
      from: '2027-02-08',
      to: '2027-02-09',
    });
    expect(first.status).toBe(201);
    await call(ctx, 'PUT', `/approvals/absences/${first.body.id}`, fx.adminA.token, { decision: 'approve' });
    // Tom (same department) overlaps one day: a second absent colleague exceeds the cap of 1
    const second = await call(ctx, 'POST', '/me/time-off-requests', emp.tom!, {
      from: '2027-02-09',
      to: '2027-02-10',
    });
    expect(second.status).toBe(422);
    expect(second.body.error.details.violations[0].code).toBe('MAX_CONCURRENT');
    // a day without overlap is fine
    expect(
      (await call(ctx, 'POST', '/me/time-off-requests', emp.tom!, { from: '2027-02-10', to: '2027-02-10' }))
        .status,
    ).toBe(201);
  });
});

describe('half-day vacation', () => {
  it("counts 0.5, leaves the day's entries in place and is restored on cancel", async () => {
    await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.maria,
      shiftId: fx.early,
      date: '2027-03-02',
    });
    expect(
      (
        await call(ctx, 'POST', '/me/time-off-requests', emp.maria!, {
          from: '2027-03-02',
          to: '2027-03-03',
          halfDay: 'morning',
        })
      ).status,
    ).toBe(400);
    const q = await call(ctx, 'POST', '/me/time-off-requests', emp.maria!, {
      from: '2027-03-02',
      to: '2027-03-02',
      halfDay: 'morning',
    });
    expect(q.status).toBe(201);
    expect(q.body).toMatchObject({ days: 0.5, halfDay: 'morning' });
    const before = (await call(ctx, 'GET', '/me/vacation?year=2027', emp.maria!)).body;
    await call(ctx, 'PUT', `/approvals/absences/${q.body.id}`, fx.adminA.token, { decision: 'approve' });
    expect((await call(ctx, 'GET', '/me/vacation?year=2027', emp.maria!)).body.used).toBe(before.used + 0.5);
    const entry = await ctx.db
      .selectFrom('schedule')
      .select('status')
      .where('employee_id', '=', fx.emp.maria!)
      .where('shift_date', '=', '2027-03-02')
      .executeTakeFirstOrThrow();
    expect(entry.status).not.toBe('cancelled');
    expect((await call(ctx, 'DELETE', `/me/time-off-requests/${q.body.id}`, emp.maria!)).status).toBe(200);
    expect((await call(ctx, 'GET', '/me/vacation?year=2027', emp.maria!)).body.used).toBe(before.used);
  });

  it('planners can enter half days; only annual leave on a single day', async () => {
    const a = await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
      employeeId: fx.emp.jon,
      from: '2027-04-06',
      to: '2027-04-06',
      type: 'annual_leave',
      halfDay: 'afternoon',
    });
    expect(a.status).toBe(201);
    expect(a.body.days).toBe(0.5);
    // the other half may still be planned: no absence conflict
    expect(
      (
        await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
          hotelId: fx.hotelA1,
          employeeId: fx.emp.jon,
          shiftId: fx.late,
          date: '2027-04-06',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
          employeeId: fx.emp.jon,
          from: '2027-04-07',
          to: '2027-04-08',
          type: 'annual_leave',
          halfDay: 'afternoon',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
          employeeId: fx.emp.jon,
          from: '2027-04-09',
          to: '2027-04-09',
          type: 'off_day',
          halfDay: 'morning',
        })
      ).status,
    ).toBe(400);
  });
});

describe('wishes', () => {
  it('employee wishes are decided by planners and contradicting entries get a warning', async () => {
    const lw = await call(ctx, 'POST', '/me/leave-wishes', emp.jon!, {
      from: '2027-05-10',
      to: '2027-05-14',
      priority: 1,
      reason: 'Wedding',
    });
    expect(lw.status).toBe(201);
    expect(lw.body.days).toBe(5);
    const sw = await call(ctx, 'POST', '/me/shift-wishes', emp.jon!, {
      date: '2027-05-17',
      shiftId: fx.late,
      priority: 2,
    });
    expect(sw.status).toBe(201);
    expect(
      (
        await call(ctx, 'POST', '/me/shift-wishes', emp.jon!, {
          date: '2027-05-17',
          shiftId: fx.late,
          priority: 2,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(ctx, 'POST', '/me/shift-wishes', emp.jon!, {
          date: '2027-05-17',
          shiftId: fx.early2,
          priority: 2,
        })
      ).status,
    ).toBe(400); // hotel A2
    expect(
      (
        await call(ctx, 'POST', '/me/leave-wishes', emp.jon!, {
          from: '2026-01-05',
          to: '2026-01-06',
          priority: 1,
        })
      ).status,
    ).toBe(400);
    // planning against the wishes is allowed but warned
    const e1 = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.early,
      date: '2027-05-11',
    });
    expect(e1.status).toBe(201);
    expect(e1.body.warnings.map((w: any) => w.code)).toContain('WISH_CONFLICT');
    const e2 = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.early,
      date: '2027-05-17',
    });
    expect(e2.body.warnings[0]).toMatchObject({ code: 'WISH_CONFLICT', details: { kind: 'shift' } });
    await call(ctx, 'DELETE', `/schedule/entries/${e2.body.entry.id}`, fx.adminA.token);
    const e3 = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.late,
      date: '2027-05-17',
    });
    expect(e3.body.warnings.map((w: any) => w.code)).not.toContain('WISH_CONFLICT');
    // inbox for planners, scope, decisions
    const list = await call(
      ctx,
      'GET',
      `/wishes?type=leave&status=pending&hotelIds=${fx.hotelA1}`,
      fx.mgrA1.token,
    );
    expect(list.body.items[0]).toMatchObject({ displayName: 'Jon T.', priority: 1 });
    expect((await call(ctx, 'GET', `/wishes?type=leave&hotelIds=${fx.hotelA1}`, fx.mgrA2.token)).status).toBe(
      403,
    );
    expect(
      (await call(ctx, 'PUT', `/wishes/leave/${lw.body.id}`, fx.mgrA2.token, { decision: 'grant' })).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'PUT', `/wishes/leave/${lw.body.id}`, fx.mgrA1.token, {
          decision: 'decline',
          note: 'peak week',
        })
      ).body.status,
    ).toBe('declined');
    expect(
      (await call(ctx, 'PUT', `/wishes/leave/${lw.body.id}`, fx.mgrA1.token, { decision: 'grant' })).status,
    ).toBe(409);
    expect((await call(ctx, 'GET', '/me/leave-wishes', emp.jon!)).body.items[0]).toMatchObject({
      status: 'declined',
      decisionNote: 'peak week',
    });
    // a declined wish no longer warns
    const e4 = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.early,
      date: '2027-05-12',
    });
    expect(e4.body.warnings.map((w: any) => w.code)).not.toContain('WISH_CONFLICT');
    // withdraw
    expect((await call(ctx, 'DELETE', `/me/shift-wishes/${sw.body.id}`, emp.jon!)).body.status).toBe(
      'withdrawn',
    );
    expect((await call(ctx, 'DELETE', `/me/shift-wishes/${sw.body.id}`, emp.jon!)).status).toBe(409);
    expect((await call(ctx, 'DELETE', `/me/shift-wishes/${sw.body.id}`, emp.tom!)).status).toBe(404);
  });
});

describe('vacation planner overview', () => {
  it('lists entitlement, carryover, taken, planned and requested per employee', async () => {
    await call(ctx, 'POST', '/me/time-off-requests', emp.tom!, { from: '2027-06-07', to: '2027-06-08' });
    const o = await call(ctx, 'GET', `/vacation/overview?year=2027&hotelIds=${fx.hotelA1}`, fx.mgrA1.token);
    expect(o.status).toBe(200);
    const jon = o.body.employees.find((e: any) => e.displayName === 'Jon T.');
    expect(jon).toMatchObject({ entitlement: 30, taken: 0 });
    expect(jon.planned).toBe(2.5); // 2 days approved earlier plus the half day
    expect(jon.months[1]).toBe(2);
    const tom = o.body.employees.find((e: any) => e.displayName === 'Tom T.');
    expect(tom.requested).toBeGreaterThanOrEqual(2);
    expect(
      (await call(ctx, 'GET', `/vacation/overview?year=2027&hotelIds=${fx.hotelA2}`, fx.mgrA1.token)).status,
    ).toBe(403);
    expect((await call(ctx, 'GET', '/vacation/overview?year=2027', emp.jon!)).status).toBe(403);
  });
});

describe('carryover and notices', () => {
  it('carries unused days into the next year (idempotent), informs employees once and expires only informed carryover', async () => {
    const m = fx.emp.maria!;
    await ctx.db
      .updateTable('employee_vacation_allowance')
      .set({ used_days: 20 })
      .where('employee_id', '=', m)
      .where('year', '=', 2026)
      .execute();
    const res = await call(ctx, 'POST', '/vacation/carryover', fx.adminA.token, { year: 2026 });
    expect(res.status).toBe(200);
    expect(res.body.carried).toBeGreaterThan(0);
    const a27 = async () =>
      ctx.db
        .selectFrom('employee_vacation_allowance')
        .selectAll()
        .where('employee_id', '=', m)
        .where('year', '=', 2027)
        .executeTakeFirstOrThrow();
    const rem = await ctx.db
      .selectFrom('employee_vacation_allowance')
      .selectAll()
      .where('employee_id', '=', m)
      .where('year', '=', 2026)
      .executeTakeFirstOrThrow();
    const carried = rem.allocated_days - 20;
    expect((await a27()).carried_statutory_days + (await a27()).carried_contractual_days).toBe(carried);
    expect((await a27()).carryover_expires_on).toBe('2027-03-31');
    expect(
      (await call(ctx, 'POST', '/vacation/carryover', fx.adminA.token, { year: 2026 })).body.carried,
    ).toBe(0); // idempotent
    expect((await call(ctx, 'POST', '/vacation/carryover', fx.mgrA1.token, { year: 2026 })).status).toBe(403);

    // without a notice the carryover does not expire
    await forfeitCarryover(ctx.db, 2027);
    expect((await a27()).carried_statutory_days + (await a27()).carried_contractual_days).toBe(carried);

    const s1 = await call(ctx, 'POST', '/vacation/notices/send', fx.adminA.token, {
      year: 2026,
      kind: 'initial',
    });
    expect(s1.body.sent).toBeGreaterThan(0);
    expect(
      (await call(ctx, 'POST', '/vacation/notices/send', fx.adminA.token, { year: 2026, kind: 'initial' }))
        .body.sent,
    ).toBe(0);
    const mine = await call(ctx, 'GET', '/me/vacation-notices', emp.maria!);
    expect(mine.body.items[0]).toMatchObject({ year: 2026, kind: 'initial', acknowledgedAt: null });
    expect(
      (await call(ctx, 'PUT', `/me/vacation-notices/${mine.body.items[0].id}/ack`, emp.maria!)).status,
    ).toBe(200);
    expect(
      (await call(ctx, 'PUT', `/me/vacation-notices/${mine.body.items[0].id}/ack`, emp.maria!)).status,
    ).toBe(404);
    const board = await call(
      ctx,
      'GET',
      `/vacation/notices?year=2026&hotelIds=${fx.hotelA1}`,
      fx.mgrA1.token,
    );
    expect(board.body.items.find((n: any) => n.employeeId === m).acknowledgedAt).not.toBeNull();

    // after the notice the unused carryover expires on 1 April; used carryover stays
    await ctx.db
      .updateTable('employee_vacation_allowance')
      .set({ used_days: 3 })
      .where('id', '=', (await a27()).id)
      .execute();
    expect((await forfeitCarryover(ctx.db, 2027)).forfeited).toBeGreaterThan(0);
    const after = await a27();
    expect(after.carried_statutory_days + after.carried_contractual_days).toBe(3);
    const acts = await ctx.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', 'in', ['vacation_carried_over', 'vacation_carryover_expired'])
      .execute();
    expect(new Set(acts.map((a) => a.action))).toEqual(
      new Set(['vacation_carried_over', 'vacation_carryover_expired']),
    );
    void carryOver;
    void sendNotices;
  });
});
