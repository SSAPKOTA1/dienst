import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAutoCheckout } from '../src/jobs/autoCheckout';
import { call, ctxHolder, planFixture, startApp, stopApp, type PlanFx, type TestCtx } from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
let token: string;
const at = (iso: string) => (ctx.now.value = new Date(iso));

beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-11T10:00:00Z') }); // Sunday
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  const d = await call(ctx, 'POST', '/kiosk-devices', fx.adminA.token, {
    hotelId: fx.hotelA1,
    name: 'Rezeption',
  });
  token = d.body.token;
  // Monday 12 Oct 2026: Maria early 06-14 (local), Jon late 14-22; published
  await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
    hotelId: fx.hotelA1,
    employeeId: fx.emp.maria,
    shiftId: fx.early,
    date: '2026-10-12',
  });
  await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
    hotelId: fx.hotelA1,
    employeeId: fx.emp.jon,
    shiftId: fx.late,
    date: '2026-10-12',
  });
  await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
    hotelId: fx.hotelA1,
    employeeId: fx.emp.tom,
    shiftId: fx.early,
    date: '2026-10-12',
  });
  await call(ctx, 'POST', '/schedule/publish', fx.adminA.token, {
    hotelIds: [fx.hotelA1],
    from: '2026-10-12',
    to: '2026-10-18',
  });
});
afterAll(async () => stopApp(ctx));

const k = (method: string, url: string, body?: unknown, tok: string | null = token) =>
  ctx.app
    .inject({
      method: method as any,
      url: `/api/v1${url}`,
      headers: tok ? { 'x-kiosk-token': tok } : {},
      payload: body as object | undefined,
    })
    .then((r) => ({ status: r.statusCode, body: r.json() as any }));

async function ref(name: string): Promise<string> {
  const s = await k('GET', `/kiosk/search?q=${name}`);
  return s.body.items[0].employeeRef;
}

describe('device and roster', () => {
  it('rejects unknown, missing and revoked devices', async () => {
    expect((await k('GET', '/kiosk/roster', undefined, null)).body.error.code).toBe('DEVICE_INVALID');
    expect((await k('GET', '/kiosk/roster', undefined, 'kd_wrong')).status).toBe(401);
    const d = await call(ctx, 'POST', '/kiosk-devices', fx.adminA.token, {
      hotelId: fx.hotelA1,
      name: 'Old',
    });
    await call(ctx, 'PUT', `/kiosk-devices/${d.body.id}`, fx.adminA.token, { status: 'revoked' });
    expect((await k('GET', '/kiosk/roster', undefined, d.body.token)).status).toBe(401);
  });

  it('roster shows published shifts within +2 h / -2 h, search finds names; heartbeat marks the tablet online', async () => {
    at('2026-10-12T03:30:00Z'); // 05:30 local: Maria and Tom start in 30 min, Jon (14:00) is out of the window
    const r = await k('GET', '/kiosk/roster');
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: any) => i.displayName).sort()).toEqual(['Maria T.', 'Tom T.']);
    expect(r.body.items[0]).toMatchObject({ state: 'not_in', departmentName: 'Rezeption' });
    expect(r.body.items[0].employeeRef).toBeTruthy();
    expect(r.body.items[0].pin).toBeUndefined();
    expect((await k('GET', '/kiosk/search?q=m')).status).toBe(400); // min 2 chars
    const s = await k('GET', '/kiosk/search?q=jo');
    expect(s.body.items.map((i: any) => i.displayName)).toEqual(['Jon T.']);
    expect((await k('POST', '/kiosk/heartbeat', {})).status).toBe(200);
    const dev = await call(ctx, 'GET', '/kiosk-devices', fx.adminA.token);
    expect(dev.body.items.find((d: any) => d.name === 'Rezeption').online).toBe(true);
    // an employeeRef is bound to the device
    const other = await call(ctx, 'POST', '/kiosk-devices', fx.adminA.token, {
      hotelId: fx.hotelA1,
      name: 'Second',
    });
    const bad = await k(
      'POST',
      '/kiosk/punch-in',
      { employeeRef: r.body.items[0].employeeRef, pin: '123456' },
      other.body.token,
    );
    expect(bad.status).toBe(401);
  });
});

describe('PIN handling', () => {
  it('shows remaining attempts, locks after 5 failures with 423 and unlocks after 15 minutes', async () => {
    at('2026-10-12T03:40:00Z');
    const e = await ref('Tom');
    for (let i = 1; i <= 4; i++) {
      const r = await k('POST', '/kiosk/punch-in', { employeeRef: e, pin: '000000' });
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('PIN_INVALID');
      expect(r.body.error.details.remainingAttempts).toBe(5 - i);
    }
    const fifth = await k('POST', '/kiosk/punch-in', { employeeRef: e, pin: '000000' });
    expect(fifth.status).toBe(423);
    expect(fifth.body.error.code).toBe('PIN_LOCKED');
    // even the right PIN is refused while locked
    expect((await k('POST', '/kiosk/punch-in', { employeeRef: e, pin: fx.pin.tom })).status).toBe(423);
    at('2026-10-12T03:56:00Z');
    expect((await k('POST', '/kiosk/punch-in', { employeeRef: e, pin: fx.pin.tom })).status).toBe(200);
    // success resets the counter
    expect(
      (
        await ctx.db
          .selectFrom('employee')
          .select('pin_failed_count')
          .where('employee_id', '=', fx.emp.tom)
          .executeTakeFirstOrThrow()
      ).pin_failed_count,
    ).toBe(0);
    // admin unlock
    await ctx.db
      .updateTable('employee')
      .set({ pin_failed_count: 5, pin_locked_until: new Date(ctx.now.value.getTime() + 600e3) })
      .where('employee_id', '=', fx.emp.jon)
      .execute();
    await call(ctx, 'POST', `/employees/${fx.emp.jon}/unlock-pin`, fx.adminA.token);
    expect(
      (await k('POST', '/kiosk/punch-in', { employeeRef: await ref('Jon'), pin: '000000' })).status,
    ).toBe(401);
    // the PIN never shows up in the logs
    expect(ctx.logs.join('\n')).not.toContain(fx.pin.tom);
  });
});

describe('clock in and out', () => {
  it('within the grace period the paid start is the planned start; two-step clock-out; auto approval', async () => {
    at('2026-10-12T04:10:00Z'); // 06:10 local: 10 min late, inside the 15 min grace
    const e = await ref('Maria');
    const inn = await k('POST', '/kiosk/punch-in', { employeeRef: e, pin: fx.pin.maria });
    expect(inn.status).toBe(200);
    expect(inn.body.variation).toEqual({ minutes: 10, withinGrace: true });
    expect(inn.body.reasonRequired).toBe(false);
    const rec = await ctx.db
      .selectFrom('punch_record')
      .selectAll()
      .where('id', '=', inn.body.punchRecordId)
      .executeTakeFirstOrThrow();
    expect(rec.actual_punch_in.toISOString()).toBe('2026-10-12T04:10:00.000Z'); // the legal record is the real time
    expect(rec.paid_start!.toISOString()).toBe('2026-10-12T04:00:00.000Z');
    expect(rec.is_unplanned).toBe(false);
    expect(rec.shift_date).toBe('2026-10-12');
    // roster now shows her as working
    const roster = await k('GET', '/kiosk/roster');
    expect(roster.body.items.find((i: any) => i.displayName === 'Maria T.').state).toBe('working');
    // double tap within 60 s: same record; later: ALREADY_CLOCKED_IN
    at('2026-10-12T04:10:30Z');
    const again = await k('POST', '/kiosk/punch-in', { employeeRef: e, pin: fx.pin.maria });
    expect(again.body.punchRecordId).toBe(inn.body.punchRecordId);
    at('2026-10-12T04:12:00Z');
    expect((await k('POST', '/kiosk/punch-in', { employeeRef: e, pin: fx.pin.maria })).status).toBe(409);
    // clock out at 14:02 local: within grace of the planned end 14:00
    at('2026-10-12T12:02:00Z');
    const out1 = await k('POST', '/kiosk/punch-out', { employeeRef: e, pin: fx.pin.maria });
    expect(out1.status).toBe(200);
    expect(out1.body).toMatchObject({
      status: 'awaiting_break_confirmation',
      grossMinutes: 480,
      requiredBreakMinutes: 30,
      suggestedBreakMinutes: 30,
    });
    expect(out1.body.options).toEqual([0, 15, 30, 45, 60]);
    // the record stays open until the break is confirmed
    expect(
      (
        await ctx.db
          .selectFrom('punch_record')
          .select('actual_punch_out')
          .where('id', '=', inn.body.punchRecordId)
          .executeTakeFirstOrThrow()
      ).actual_punch_out,
    ).toBeNull();
    // the out time is fixed at step 1 even if confirmation takes a minute
    at('2026-10-12T12:03:00Z');
    const conf = await k('POST', '/kiosk/punch-out/confirm-break', {
      confirmToken: out1.body.confirmToken,
      actualBreakMinutes: 30,
    });
    expect(conf.status).toBe(200);
    expect(conf.body).toEqual({ status: 'clocked_out', paidHours: 7.5, approvalStatus: 'approved' });
    const done = await ctx.db
      .selectFrom('punch_record')
      .selectAll()
      .where('id', '=', inn.body.punchRecordId)
      .executeTakeFirstOrThrow();
    expect(done.actual_punch_out!.toISOString()).toBe('2026-10-12T12:02:00.000Z');
    expect(done.paid_end!.toISOString()).toBe('2026-10-12T12:00:00.000Z');
    expect([done.approval_status, done.approval_source, done.actual_break_minutes]).toEqual([
      'approved',
      'auto',
      30,
    ]);
    const hist = await ctx.db
      .selectFrom('punch_record_history')
      .select('change_type')
      .where('punch_record_id', '=', done.id)
      .execute();
    expect(hist.map((h) => h.change_type)).toEqual(['clock_in', 'clock_out']);
    const vars = await ctx.db
      .selectFrom('time_variation')
      .select('id')
      .where('punch_record_id', '=', done.id)
      .execute();
    expect(vars).toHaveLength(0);
    expect(
      (
        await ctx.db
          .selectFrom('audit_log')
          .select('action')
          .where('entity_id', '=', done.id)
          .where('entity_type', '=', 'punch_record')
          .execute()
      ).map((a) => a.action),
    ).toEqual(['punch_in', 'punch_out']);
  });

  it('outside the grace period the paid time follows the real punches and a variation needs approval', async () => {
    // Jon: late 14-22. punches in 20 minutes early and out 30 minutes late
    at('2026-10-12T11:40:00Z'); // 13:40 local
    const e = await ref('Jon');
    const inn = await k('POST', '/kiosk/punch-in', { employeeRef: e, pin: fx.pin.jon });
    expect(inn.body.variation).toEqual({ minutes: -20, withinGrace: false });
    expect(inn.body.reasonRequired).toBe(true);
    expect(
      (
        await k('POST', '/kiosk/punch/reason', {
          confirmToken: inn.body.confirmToken,
          reason: 'Ich war früher da',
        })
      ).status,
    ).toBe(200);
    at('2026-10-12T20:30:00Z'); // 22:30 local
    const out = await k('POST', '/kiosk/punch-out', { employeeRef: e, pin: fx.pin.jon });
    const conf = await k('POST', '/kiosk/punch-out/confirm-break', {
      confirmToken: out.body.confirmToken,
      actualBreakMinutes: 30,
    });
    expect(conf.body.approvalStatus).toBe('pending');
    expect(conf.body.paidHours).toBe(8.33); // 13:40-22:30 = 530 min gross, minus a 30 min break = 500 min
    const vars = await ctx.db
      .selectFrom('time_variation')
      .select(['variation_type', 'status', 'reason', 'variation_minutes'])
      .where('punch_record_id', '=', inn.body.punchRecordId)
      .orderBy('id')
      .execute();
    expect(vars.map((v) => `${v.variation_type}:${v.status}:${v.variation_minutes}`)).toEqual([
      'clock_in_early:pending:-20',
      'clock_out_late:pending:30',
    ]);
    expect(vars[0].reason).toBe('Ich war früher da');
  });

  it('a break below the required minimum needs a reason (422 REASON_REQUIRED); with one the record is flagged', async () => {
    // Tom clocked in on Monday at 05:56 local (PIN test) and now leaves at 14:00 without a break
    at('2026-10-12T12:00:00Z');
    const e = await ref('Tom');
    const out = await k('POST', '/kiosk/punch-out', { employeeRef: e, pin: fx.pin.tom });
    expect(out.body.requiredBreakMinutes).toBe(30);
    const none = await k('POST', '/kiosk/punch-out/confirm-break', {
      confirmToken: out.body.confirmToken,
      actualBreakMinutes: 0,
    });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('REASON_REQUIRED');
    const ok = await k('POST', '/kiosk/punch-out/confirm-break', {
      confirmToken: out.body.confirmToken,
      actualBreakMinutes: 0,
      reason: 'Keine Zeit für eine Pause',
    });
    expect(ok.body).toMatchObject({
      status: 'clocked_out_with_warning',
      approvalStatus: 'pending',
      paidHours: 8,
    });
    // a replayed confirmation is harmless
    expect(
      (
        await k('POST', '/kiosk/punch-out/confirm-break', {
          confirmToken: out.body.confirmToken,
          actualBreakMinutes: 0,
          reason: 'Keine Zeit für eine Pause',
        })
      ).status,
    ).toBe(200);
    // clocking out without being clocked in
    expect((await k('POST', '/kiosk/punch-out', { employeeRef: e, pin: fx.pin.tom })).status).toBe(404);
  });
});

describe('unplanned punches, auto checkout and the live board', () => {
  it('an employee without an entry clocks in as unplanned and gets a pending variation', async () => {
    at('2026-10-14T08:00:00Z'); // Wednesday, nothing planned
    const e = await ref('Lena');
    const inn = await k('POST', '/kiosk/punch-in', { employeeRef: e, pin: fx.pin.lena });
    expect(inn.status).toBe(200);
    expect(inn.body.isUnplanned).toBe(true);
    const rec = await ctx.db
      .selectFrom('punch_record')
      .selectAll()
      .where('id', '=', inn.body.punchRecordId)
      .executeTakeFirstOrThrow();
    expect([rec.is_unplanned, rec.schedule_id, rec.paid_start!.toISOString()]).toEqual([
      true,
      null,
      '2026-10-14T08:00:00.000Z',
    ]);
    const v = await ctx.db
      .selectFrom('time_variation')
      .select(['variation_type', 'status'])
      .where('punch_record_id', '=', rec.id)
      .execute();
    expect(v).toEqual([{ variation_type: 'unplanned', status: 'pending' }]);
    // 4 hours later: short break is fine for < 6 h; 7 h means a break is required -> reason
    at('2026-10-14T15:30:00Z');
    const out = await k('POST', '/kiosk/punch-out', { employeeRef: e, pin: fx.pin.lena });
    expect(out.body.grossMinutes).toBe(450);
    expect(out.body.requiredBreakMinutes).toBe(30);
    const noReason = await k('POST', '/kiosk/punch-out/confirm-break', {
      confirmToken: out.body.confirmToken,
      actualBreakMinutes: 15,
    });
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    const ok = await k('POST', '/kiosk/punch-out/confirm-break', {
      confirmToken: out.body.confirmToken,
      actualBreakMinutes: 15,
      reason: 'Es war viel los',
    });
    expect(ok.body).toMatchObject({ status: 'clocked_out_with_warning', approvalStatus: 'pending' });
    const done = await ctx.db
      .selectFrom('punch_record')
      .select(['under_break_warning', 'actual_break_minutes'])
      .where('id', '=', rec.id)
      .executeTakeFirstOrThrow();
    expect(done).toEqual({ under_break_warning: true, actual_break_minutes: 15 });
  });

  it('the live board groups clocked-in, expected, no-show and needs-review; managers close open records (not their own)', async () => {
    // Friday 16 Oct: three entries 06-14: Maria in, Jon expected-late (30 min), Tom no-show (90 min)
    at('2026-10-15T10:00:00Z');
    for (const emp of [fx.emp.maria, fx.emp.jon, fx.emp.tom])
      await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
        hotelId: fx.hotelA1,
        employeeId: emp,
        shiftId: fx.early,
        date: '2026-10-16',
      });
    await call(ctx, 'POST', '/schedule/publish', fx.adminA.token, {
      hotelIds: [fx.hotelA1],
      from: '2026-10-12',
      to: '2026-10-18',
    });
    at('2026-10-16T04:05:00Z');
    expect(
      (await k('POST', '/kiosk/punch-in', { employeeRef: await ref('Maria'), pin: fx.pin.maria })).status,
    ).toBe(200);
    at('2026-10-16T04:35:00Z'); // 06:35 local
    let live = await call(ctx, 'GET', `/live?hotelIds=${fx.hotelA1}`, fx.mgrA1.token);
    expect(live.body.groups.clockedIn.map((x: any) => x.displayName)).toEqual(['Maria T.']);
    expect(live.body.groups.expectedNotIn.map((x: any) => x.displayName).sort()).toEqual([
      'Jon T.',
      'Tom T.',
    ]);
    expect(live.body.groups.noShow).toEqual([]);
    at('2026-10-16T05:35:00Z'); // 07:35 local: 95 min late
    live = await call(ctx, 'GET', `/live?hotelIds=${fx.hotelA1}`, fx.mgrA1.token);
    expect(live.body.groups.expectedNotIn).toEqual([]);
    expect(live.body.groups.noShow.map((x: any) => x.displayName).sort()).toEqual(['Jon T.', 'Tom T.']);
    // Maria forgot to clock out: after 15:00 local she needs review
    at('2026-10-16T13:30:00Z'); // 15:30 local = planned end + 90 min
    live = await call(ctx, 'GET', `/live?hotelIds=${fx.hotelA1}`, fx.mgrA1.token);
    expect(live.body.groups.clockedIn).toEqual([]);
    expect(live.body.groups.needsReview).toHaveLength(1);
    expect(live.body.groups.needsReview[0]).toMatchObject({
      displayName: 'Maria T.',
      reason: 'past_planned_end',
    });
    const id = live.body.groups.needsReview[0].punchRecordId;
    // scope and validation
    expect((await call(ctx, 'GET', `/live?hotelIds=${fx.hotelA2}`, fx.mgrA1.token)).status).toBe(403);
    expect(
      (
        await call(ctx, 'POST', '/live/close-open', fx.mgrA2.token, {
          punchRecordId: id,
          outAt: '2026-10-16T12:00:00Z',
          breakMinutes: 30,
          reason: 'vergessen',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'POST', '/live/close-open', fx.mgrA1.token, {
          punchRecordId: id,
          outAt: '2026-10-16T20:00:00Z',
          breakMinutes: 30,
          reason: 'vergessen',
        })
      ).status,
    ).toBe(400);
    const closed = await call(ctx, 'POST', '/live/close-open', fx.mgrA1.token, {
      punchRecordId: id,
      outAt: '2026-10-16T12:00:00Z',
      breakMinutes: 30,
      reason: 'Ausstempeln vergessen',
    });
    expect(closed.status).toBe(200);
    const rec = await ctx.db
      .selectFrom('punch_record')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect([rec.source, rec.approval_status, rec.approval_source, rec.paid_hours]).toEqual([
      'correction',
      'approved',
      'manual',
      7.5,
    ]);
    expect(
      await ctx.db
        .selectFrom('punch_record_history')
        .select('id')
        .where('punch_record_id', '=', id)
        .where('change_type', '=', 'close_open')
        .executeTakeFirst(),
    ).toBeTruthy();
    expect(
      (
        await call(ctx, 'POST', '/live/close-open', fx.mgrA1.token, {
          punchRecordId: id,
          outAt: '2026-10-16T12:00:00Z',
          breakMinutes: 30,
          reason: 'nochmal',
        })
      ).status,
    ).toBe(409);
  });

  it('auto checkout: planned entries 60 min after the planned end, unplanned records after 12 h; managers and employee are notified', async () => {
    at('2026-10-19T04:00:00Z'); // Monday 19 Oct 06:00 local
    await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.early,
      date: '2026-10-19',
    }).catch(() => null);
    at('2026-10-17T10:00:00Z');
    await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.early,
      date: '2026-10-19',
    });
    await call(ctx, 'POST', '/schedule/publish', fx.adminA.token, {
      hotelIds: [fx.hotelA1],
      from: '2026-10-19',
      to: '2026-10-25',
    });
    at('2026-10-19T04:02:00Z');
    const inn = await k('POST', '/kiosk/punch-in', { employeeRef: await ref('Jon'), pin: fx.pin.jon });
    expect(inn.status).toBe(200);
    at('2026-10-19T12:59:00Z'); // 14:59 local: 59 min after the planned end
    expect(await runAutoCheckout(ctx.db, ctx.now.value)).toBe(0);
    at('2026-10-19T13:01:00Z');
    expect(await runAutoCheckout(ctx.db, ctx.now.value)).toBe(1);
    const rec = await ctx.db
      .selectFrom('punch_record')
      .selectAll()
      .where('id', '=', inn.body.punchRecordId)
      .executeTakeFirstOrThrow();
    expect(rec.actual_punch_out!.toISOString()).toBe('2026-10-19T12:00:00.000Z');
    expect([rec.auto_checked_out, rec.approval_status, rec.actual_break_minutes, rec.paid_hours]).toEqual([
      true,
      'pending',
      30,
      7.5,
    ]);
    const notes = await ctx.db
      .selectFrom('notification')
      .select('user_id')
      .where('kind', '=', 'auto_checkout')
      .execute();
    expect(notes.length).toBeGreaterThanOrEqual(2); // employee and the manager(s) of the hotel
    expect(await runAutoCheckout(ctx.db, ctx.now.value)).toBe(0);
    // unplanned and open for more than 12 h
    at('2026-10-20T06:00:00Z');
    const un = await k('POST', '/kiosk/punch-in', { employeeRef: await ref('Lena'), pin: fx.pin.lena });
    expect(un.body.isUnplanned).toBe(true);
    at('2026-10-20T17:00:00Z');
    expect(await runAutoCheckout(ctx.db, ctx.now.value)).toBe(0);
    at('2026-10-20T18:30:00Z');
    expect(await runAutoCheckout(ctx.db, ctx.now.value)).toBe(1);
    const r2 = await ctx.db
      .selectFrom('punch_record')
      .selectAll()
      .where('id', '=', un.body.punchRecordId)
      .executeTakeFirstOrThrow();
    expect(r2.actual_punch_out!.toISOString()).toBe('2026-10-20T14:00:00.000Z'); // in + 8 h
  });
});

describe('tablet bookkeeping', () => {
  let fresh: string;
  beforeAll(async () => {
    const d = await call(ctx, 'POST', '/kiosk-devices', fx.adminA.token, {
      hotelId: fx.hotelA1,
      name: 'Bookkeeping',
    });
    fresh = d.body.token;
  });
  it('writes the last-seen time at most every 30 seconds, but always shows the tablet as online', async () => {
    const seen = async () =>
      (
        await ctx.db
          .selectFrom('kiosk_device')
          .select('last_seen_at')
          .where('hotel_id', '=', fx.hotelA1)
          .where('name', '=', 'Bookkeeping')
          .executeTakeFirstOrThrow()
      ).last_seen_at as Date;
    at('2026-10-20T10:00:00Z');
    await k('GET', '/kiosk/roster', undefined, fresh);
    const first = (await seen()).getTime();
    at('2026-10-20T10:00:20Z');
    await k('GET', '/kiosk/roster', undefined, fresh);
    expect((await seen()).getTime()).toBe(first); // 20 s later: not written again
    at('2026-10-20T10:00:40Z');
    await k('GET', '/kiosk/roster', undefined, fresh);
    expect((await seen()).getTime()).toBe(new Date('2026-10-20T10:00:40Z').getTime());
  });
  it('reuses the signed person references of the roster while they stay valid', async () => {
    at('2026-10-12T04:00:00Z');
    const a = (await k('GET', '/kiosk/roster', undefined, fresh)).body.items.map(
      (i: { employeeRef: string }) => i.employeeRef,
    );
    at('2026-10-12T04:01:00Z');
    const b = (await k('GET', '/kiosk/roster', undefined, fresh)).body.items.map(
      (i: { employeeRef: string }) => i.employeeRef,
    );
    expect(b.sort()).toEqual(a.sort());
  });
});
