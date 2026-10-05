import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, ctxHolder, planFixture, startApp, stopApp, type PlanFx, type TestCtx } from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-04T10:00:00Z') }); // Sunday
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  // requirements: Früh needs 2 on weekdays
  await call(ctx, 'PUT', `/shifts/${fx.early}/staffing`, fx.adminA.token, {
    weekdayDefaults: { '1': 2, '2': 2, '3': 2, '4': 2, '5': 2 },
  });
});
afterAll(async () => stopApp(ctx));

const W = '2026-10-12'; // Monday of the test week
const WE = '2026-10-18';
const day = (n: number) => new Date(Date.UTC(2026, 9, 12 + n)).toISOString().slice(0, 10);
const entry = (token: string, body: Record<string, unknown>) =>
  call(ctx, 'POST', '/schedule/entries', token, { hotelId: fx.hotelA1, ...body });
const changes = async (from = W, to = WE) =>
  (await call(ctx, 'GET', `/schedule/changes?hotelIds=${fx.hotelA1}&from=${from}&to=${to}`, fx.mgrA1.token))
    .body.changes as any[];
const publish = (from = W, to = WE) =>
  call(ctx, 'POST', '/schedule/publish', fx.mgrA1.token, { hotelIds: [fx.hotelA1], from, to });
const notices = (emp: number, kind: string) =>
  ctx.db
    .selectFrom('notification')
    .selectAll()
    .where('employee_id', '=', emp)
    .where('kind', '=', kind)
    .execute();

describe('publishing and change tracking', () => {
  let maria: number;
  let jon: number;
  it('a never published week reports every entry as new; publish sets published, writes a snapshot and notifies', async () => {
    maria = (await entry(fx.adminA.token, { employeeId: fx.emp.maria, shiftId: fx.early, date: day(0) })).body
      .entry.id;
    jon = (await entry(fx.adminA.token, { employeeId: fx.emp.jon, shiftId: fx.early, date: day(1) })).body
      .entry.id;
    await entry(fx.adminA.token, { employeeId: fx.emp.jon, shiftId: fx.late, date: day(2) });
    const c = await changes();
    expect(c.map((x) => x.type)).toEqual(['new', 'new', 'new']);
    const p = await publish();
    expect(p.status).toBe(200);
    expect(p.body.published).toBe(3);
    expect(p.body.changedCount).toBe(3);
    expect(p.body.openSlots).toBeGreaterThan(0); // Früh needs 2 on weekdays, only 1-2 assigned
    const rows = await ctx.db
      .selectFrom('schedule')
      .select('status')
      .where('shift_date', '>=', W)
      .where('shift_date', '<=', WE)
      .execute();
    expect(rows.every((r) => r.status === 'published')).toBe(true);
    const snap = await ctx.db
      .selectFrom('schedule_snapshot')
      .selectAll()
      .where('hotel_id', '=', fx.hotelA1)
      .executeTakeFirstOrThrow();
    expect(snap.week_start).toBe(W);
    expect((snap.snapshot as any[]).map((s) => s.id).sort()).toEqual(
      [maria, jon, (snap.snapshot as any[])[2].id].sort(),
    );
    expect(await changes()).toEqual([]);
    expect((await notices(fx.emp.maria, 'schedule_published')).length).toBe(1);
    expect((await notices(fx.emp.jon, 'schedule_published')).length).toBe(1);
    expect((await notices(fx.emp.lena, 'schedule_published')).length).toBe(0);
    const g = await call(
      ctx,
      'GET',
      `/schedule/grid?hotelIds=${fx.hotelA1}&view=shift&from=${W}`,
      fx.mgrA1.token,
    );
    expect(g.body.status).toBe('published');
  });

  it('changing a published entry keeps it published, flags it as changed and notifies once', async () => {
    const m = await call(ctx, 'POST', '/schedule/move', fx.mgrA1.token, {
      entryId: maria,
      version: 1,
      toDate: day(3),
    });
    expect(m.status).toBe(200);
    expect(
      (await ctx.db.selectFrom('schedule').select('status').where('id', '=', maria).executeTakeFirstOrThrow())
        .status,
    ).toBe('published');
    const c = await changes();
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ entryId: maria, type: 'changed', date: day(3) });
    expect(c[0].from.date).toBe(day(0));
    expect((await notices(fx.emp.maria, 'schedule_changed')).length).toBe(1);
    // a new draft next to it
    const n = await entry(fx.adminA.token, { employeeId: fx.emp.tom, shiftId: fx.early, date: day(4) });
    expect((await changes()).map((x) => x.type).sort()).toEqual(['changed', 'new']);
    expect(n.body.entry.status).toBe('draft');
    // publishing does not notify Maria a second time for the same change; Tom gets schedule_published
    const p = await publish();
    expect(p.body.changedCount).toBe(2);
    expect((await notices(fx.emp.maria, 'schedule_changed')).length).toBe(1);
    expect((await notices(fx.emp.tom, 'schedule_published')).length).toBe(1);
    expect(await changes()).toEqual([]);
  });

  it('deleting a published entry cancels it ("removed" until the next publication); deleting a draft removes the row', async () => {
    const d = await call(ctx, 'DELETE', `/schedule/entries/${jon}`, fx.mgrA1.token);
    expect(d.body.cancelled).toBe(true);
    const row = await ctx.db
      .selectFrom('schedule')
      .select(['status', 'cancel_reason'])
      .where('id', '=', jon)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'cancelled', cancel_reason: 'changed' });
    expect((await changes()).map((x) => `${x.type}:${x.entryId}`)).toEqual([`removed:${jon}`]);
    const grid = await call(
      ctx,
      'GET',
      `/schedule/grid?hotelIds=${fx.hotelA1}&view=employee&from=${W}`,
      fx.mgrA1.token,
    );
    const jonRow = grid.body.rows.find((r: any) => r.employeeId === fx.emp.jon);
    const ghost = jonRow.cells[1].entries.find((e: any) => e.id === jon);
    expect(ghost).toMatchObject({ status: 'cancelled', change: 'removed' });
    const draft = await entry(fx.adminA.token, { employeeId: fx.emp.piotr, shiftId: fx.hk, date: day(1) });
    expect(
      (await call(ctx, 'DELETE', `/schedule/entries/${draft.body.entry.id}`, fx.adminA.token)).body.cancelled,
    ).toBe(false);
    expect(
      await ctx.db
        .selectFrom('schedule')
        .select('id')
        .where('id', '=', draft.body.entry.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    await publish();
    expect(await changes()).toEqual([]);
    expect((await notices(fx.emp.jon, 'schedule_changed')).length).toBe(1);
  });
});

describe('revert, clear and copy', () => {
  it('revert restores the snapshot state: deletes new, resets changed, un-cancels removed', async () => {
    const wk = day(7); // next week: 19 Oct
    const a = await entry(fx.adminA.token, { employeeId: fx.emp.maria, shiftId: fx.early, date: wk });
    const b = await entry(fx.adminA.token, { employeeId: fx.emp.jon, shiftId: fx.early, date: day(8) });
    await publish(wk, day(13));
    await call(ctx, 'POST', '/schedule/move', fx.adminA.token, {
      entryId: a.body.entry.id,
      version: 1,
      toDate: day(9),
    }); // changed
    await call(ctx, 'DELETE', `/schedule/entries/${b.body.entry.id}`, fx.adminA.token); // removed
    const n = await entry(fx.adminA.token, { employeeId: fx.emp.tom, shiftId: fx.early, date: day(10) }); // new
    expect((await changes(wk, day(13))).map((x) => x.type).sort()).toEqual(['changed', 'new', 'removed']);
    // single entry
    const one = await call(ctx, 'POST', '/schedule/revert', fx.adminA.token, {
      hotelIds: [fx.hotelA1],
      from: wk,
      to: day(13),
      entryId: a.body.entry.id,
    });
    expect(one.body.reset).toBe(1);
    expect(
      (
        await ctx.db
          .selectFrom('schedule')
          .select('shift_date')
          .where('id', '=', a.body.entry.id)
          .executeTakeFirstOrThrow()
      ).shift_date,
    ).toBe(wk);
    // the rest
    const all = await call(ctx, 'POST', '/schedule/revert', fx.adminA.token, {
      hotelIds: [fx.hotelA1],
      from: wk,
      to: day(13),
    });
    expect(all.body).toMatchObject({ deleted: 1, restored: 1 });
    expect(await changes(wk, day(13))).toEqual([]);
    expect(
      (
        await ctx.db
          .selectFrom('schedule')
          .select('status')
          .where('id', '=', b.body.entry.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('published');
    expect(
      await ctx.db.selectFrom('schedule').select('id').where('id', '=', n.body.entry.id).executeTakeFirst(),
    ).toBeUndefined();
  });

  it('revert is not allowed for past days', async () => {
    const e = await entry(fx.adminA.token, { employeeId: fx.emp.piotr, shiftId: fx.hk, date: '2026-11-10' });
    await publish('2026-11-09', '2026-11-15');
    await call(ctx, 'POST', '/schedule/move', fx.adminA.token, {
      entryId: e.body.entry.id,
      version: 1,
      toDate: '2026-11-11',
    });
    ctx.now.value = new Date('2026-11-12T10:00:00Z'); // both days are past now
    const one = await call(ctx, 'POST', '/schedule/revert', fx.adminA.token, {
      hotelIds: [fx.hotelA1],
      from: '2026-11-09',
      to: '2026-11-15',
      entryId: e.body.entry.id,
    });
    expect(one.status).toBe(422);
    expect(one.body.error.details.violations[0].code).toBe('PAST_DAY');
    const range = await call(ctx, 'POST', '/schedule/revert', fx.adminA.token, {
      hotelIds: [fx.hotelA1],
      from: '2026-11-09',
      to: '2026-11-15',
    });
    expect(range.body.skipped).toEqual([{ entryId: e.body.entry.id, reason: 'PAST_DAY' }]);
    // moving or deleting an entry on a past day is refused as well
    expect((await call(ctx, 'DELETE', `/schedule/entries/${e.body.entry.id}`, fx.adminA.token)).status).toBe(
      422,
    );
    ctx.now.value = new Date('2026-10-04T10:00:00Z');
  });

  it('clear-week removes drafts and cancels published entries for today and later only; absences stay', async () => {
    ctx.now.value = new Date('2026-10-26T10:00:00Z'); // Monday 26 Oct
    const wk = '2026-10-26';
    const past = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.maria,
      shiftId: fx.early,
      date: wk,
    });
    const pub = await entry(fx.adminA.token, {
      employeeId: fx.emp.jon,
      shiftId: fx.early,
      date: '2026-10-27',
    });
    await publish(wk, '2026-11-01');
    ctx.now.value = new Date('2026-10-27T10:00:00Z'); // Tuesday: Monday is past
    await entry(fx.adminA.token, { employeeId: fx.emp.tom, shiftId: fx.early, date: '2026-10-28' }); // draft
    await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
      employeeId: fx.emp.lena,
      from: '2026-10-29',
      to: '2026-10-29',
      type: 'off_day',
    });
    const r = await call(ctx, 'POST', '/schedule/clear-week', fx.adminA.token, {
      hotelIds: [fx.hotelA1],
      from: wk,
      to: '2026-11-01',
    });
    expect(r.body).toEqual({ deleted: 1, cancelledPublished: 1 });
    expect(
      (
        await ctx.db
          .selectFrom('schedule')
          .select('status')
          .where('id', '=', past.body.entry.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('published'); // past day stays
    expect(
      (
        await ctx.db
          .selectFrom('schedule')
          .select('status')
          .where('id', '=', pub.body.entry.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('cancelled');
    expect(
      (
        await ctx.db
          .selectFrom('time_off')
          .select('status')
          .where('employee_id', '=', fx.emp.lena)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('approved');
    ctx.now.value = new Date('2026-10-04T10:00:00Z');
  });

  it('copy-week copies entries as drafts and skips blocked ones, returning them', async () => {
    // source week 12-18 Oct: Maria (moved to day 3), Tom (day 4)... target week 2-8 Nov
    await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
      employeeId: fx.emp.tom,
      from: '2026-11-06',
      to: '2026-11-06',
      type: 'annual_leave',
    });
    const r = await call(ctx, 'POST', '/schedule/copy-week', fx.mgrA1.token, {
      hotelIds: [fx.hotelA1],
      fromWeek: W,
      toWeek: '2026-11-02',
    });
    expect(r.status).toBe(200);
    expect(r.body.created).toBeGreaterThan(0);
    expect(r.body.skipped.some((s: any) => s.codes.includes('ABSENCE_CONFLICT'))).toBe(true);
    const copied = await ctx.db
      .selectFrom('schedule')
      .select(['status', 'shift_date'])
      .where('shift_date', '>=', '2026-11-02')
      .where('shift_date', '<=', '2026-11-08')
      .execute();
    expect(copied.every((c) => c.status === 'draft')).toBe(true);
    // running it again only reports overlaps
    const again = await call(ctx, 'POST', '/schedule/copy-week', fx.mgrA1.token, {
      hotelIds: [fx.hotelA1],
      fromWeek: W,
      toWeek: '2026-11-02',
    });
    expect(again.body.created).toBe(0);
    expect(
      again.body.skipped.every(
        (s: any) => s.codes.includes('OVERLAP') || s.codes.includes('ABSENCE_CONFLICT'),
      ),
    ).toBe(true);
  });
});

describe('substitute finder', () => {
  it('lists employees without blocks, fewest warnings and fewest weekly hours first', async () => {
    const date = '2026-12-01'; // Tuesday
    // Maria: nothing that week, Jon: 8 h (late the day before -> rest warning), Tom: 7.5 h earlier in the week
    await entry(fx.adminA.token, { employeeId: fx.emp.jon, shiftId: fx.late, date: '2026-11-30' });
    await entry(fx.adminA.token, { employeeId: fx.emp.tom, shiftId: fx.early, date: '2026-12-03' });
    await entry(fx.adminA.token, { employeeId: fx.emp.lena, date: date, start: '08:00', end: '12:00' }); // Lena is busy -> overlap with the slot
    await entry(fx.adminA.token, {
      employeeId: fx.emp.maria,
      date: '2026-11-30',
      start: '12:00',
      end: '20:00',
    }); // 10 h gap to 06:00: a warning, not a block
    const r = await call(
      ctx,
      'GET',
      `/schedule/candidates?hotelIds=${fx.hotelA1}&departmentId=${fx.deptA1}&date=${date}&shiftId=${fx.early}`,
      fx.mgrA1.token,
    );
    expect(r.status).toBe(200);
    const names = r.body.items.map((c: any) => c.displayName);
    expect(names).not.toContain('Lena T.'); // overlap = block
    expect(names).not.toContain('Piotr T.'); // wrong department
    expect(names).not.toContain('Jon T.'); // 8 h rest after the late shift: blocked
    const first = r.body.items[0];
    expect(first.warnings).toEqual([]);
    // sorted by warnings ascending, then planned weekly hours ascending
    const keys = r.body.items.map((c: any) => [c.warnings.length, c.weekHours]);
    expect(keys).toEqual([...keys].sort((a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1]));
    const mariaItem = r.body.items.find((c: any) => c.displayName === 'Maria T.');
    expect(mariaItem.warnings.map((w: any) => w.code)).toEqual(['REST_PERIOD']);
    expect(r.body.items[r.body.items.length - 1].displayName).toBe('Maria T.'); // the only candidate with a warning comes last
  });
});
