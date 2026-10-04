import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../src/lib/security';
import {
  call,
  ctxHolder,
  loginAs,
  planFixture,
  startApp,
  stopApp,
  type PlanFx,
  type TestCtx,
} from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
const emp: Record<string, string> = {}; // employee tokens
const at = (iso: string) => (ctx.now.value = new Date(iso));

async function activate(key: string) {
  const email = `${key}@emp.test`;
  const id = fx.emp[key]!;
  const e = await ctx.db
    .selectFrom('employee')
    .select('user_id')
    .where('employee_id', '=', id)
    .executeTakeFirstOrThrow();
  await ctx.db
    .updateTable('user_account')
    .set({ email, password_hash: await hashSecret('Passw0rd!23'), status: 'active' })
    .where('id', '=', e.user_id)
    .execute();
  emp[key] = await loginAs(ctx, email, 'employee', { employeeId: id });
}

/** Direct insert of a finished record (kiosk flow itself is covered in kiosk.test.ts). */
async function rec(key: string, date: string, from: string, to: string, over: Record<string, unknown> = {}) {
  const start = new Date(from);
  const end = new Date(to);
  const hours = (end.getTime() - start.getTime()) / 3600e3 - 0.5;
  return (
    await ctx.db
      .insertInto('punch_record')
      .values({
        employee_id: fx.emp[key]!,
        hotel_id: fx.hotelA1,
        shift_date: date,
        actual_punch_in: start,
        actual_punch_out: end,
        paid_start: start,
        paid_end: end,
        actual_break_minutes: 30,
        required_break_minutes: 30,
        paid_hours: hours,
        approval_status: 'pending',
        ...over,
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
}

beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-20T10:00:00Z') });
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  for (const k of ['maria', 'jon', 'tom']) await activate(k);
});
afterAll(async () => stopApp(ctx));

describe('worked-time approvals', () => {
  it('approve with adjustments recomputes paid hours, keeps actual times, writes history and notifies', async () => {
    const id = await rec('maria', '2026-10-12', '2026-10-12T04:00:00Z', '2026-10-12T12:00:00Z');
    const list = await call(ctx, 'GET', '/approvals?type=worked_time&status=pending', fx.mgrA1.token);
    expect(list.status).toBe(200);
    const item = list.body.items.find((i: any) => i.id === id);
    expect(item).toMatchObject({ displayName: 'Maria T.', flags: [], ageDays: 8, overdue: true });
    const r = await call(ctx, 'PUT', `/approvals/worked-time/${id}`, fx.mgrA1.token, {
      decision: 'approve',
      paidEnd: '2026-10-12T11:30:00Z',
      breakMinutes: 30,
      notes: 'left early',
    });
    expect(r.status).toBe(200);
    expect(r.body.paidHours).toBeCloseTo(7, 2);
    const row = await ctx.db
      .selectFrom('punch_record')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.actual_punch_out!.toISOString()).toBe('2026-10-12T12:00:00.000Z');
    expect(row.approval_status).toBe('approved');
    expect(row.approval_source).toBe('manual');
    const h = await ctx.db
      .selectFrom('punch_record_history')
      .selectAll()
      .where('punch_record_id', '=', id)
      .execute();
    expect(h.map((x) => x.change_type)).toContain('approved');
    const n = await ctx.db
      .selectFrom('notification')
      .selectAll()
      .where('kind', '=', 'approval_decision')
      .execute();
    expect(n.length).toBeGreaterThan(0);
    const a = await ctx.db
      .selectFrom('audit_log')
      .select('action')
      .where('entity_id', '=', id)
      .where('entity_type', '=', 'punch_record')
      .execute();
    expect(a.map((x) => x.action)).toContain('worked_time_approved');
    // deciding twice is a conflict
    expect(
      (await call(ctx, 'PUT', `/approvals/worked-time/${id}`, fx.mgrA1.token, { decision: 'approve' }))
        .status,
    ).toBe(409);
  });

  it('reject falls back to planned times (or zero hours when unplanned) and rejects variations', async () => {
    const planned = await rec('jon', '2026-10-13', '2026-10-13T05:00:00Z', '2026-10-13T13:00:00Z', {
      planned_start: new Date('2026-10-13T04:00:00Z'),
      planned_end: new Date('2026-10-13T12:00:00Z'),
    });
    await ctx.db
      .insertInto('time_variation')
      .values({
        punch_record_id: planned,
        employee_id: fx.emp.jon!,
        hotel_id: fx.hotelA1,
        variation_type: 'clock_in_late',
        actual_time: new Date('2026-10-13T05:00:00Z'),
        variation_minutes: 60,
        status: 'pending',
      } as any)
      .execute();
    const r = await call(ctx, 'PUT', `/approvals/worked-time/${planned}`, fx.adminA.token, {
      decision: 'reject',
      notes: 'late',
    });
    expect(r.status).toBe(200);
    const row = await ctx.db
      .selectFrom('punch_record')
      .selectAll()
      .where('id', '=', planned)
      .executeTakeFirstOrThrow();
    expect(row.paid_start!.toISOString()).toBe('2026-10-13T04:00:00.000Z');
    expect(row.paid_end!.toISOString()).toBe('2026-10-13T12:00:00.000Z');
    expect(row.approval_status).toBe('rejected');
    const v = await ctx.db
      .selectFrom('time_variation')
      .select('status')
      .where('punch_record_id', '=', planned)
      .executeTakeFirstOrThrow();
    expect(v.status).toBe('rejected');
    const unplanned = await rec('jon', '2026-10-14', '2026-10-14T05:00:00Z', '2026-10-14T09:00:00Z', {
      is_unplanned: true,
    });
    await call(ctx, 'PUT', `/approvals/worked-time/${unplanned}`, fx.adminA.token, { decision: 'reject' });
    const u = await ctx.db
      .selectFrom('punch_record')
      .select(['paid_hours', 'approval_status'])
      .where('id', '=', unplanned)
      .executeTakeFirstOrThrow();
    expect(u).toMatchObject({ paid_hours: 0, approval_status: 'rejected' });
  });

  it('bulk approve takes only unflagged records and reports the others', async () => {
    const clean = await rec('maria', '2026-10-15', '2026-10-15T04:00:00Z', '2026-10-15T12:00:00Z');
    const flagged = await rec('maria', '2026-10-16', '2026-10-16T04:00:00Z', '2026-10-16T12:00:00Z', {
      is_unplanned: true,
    });
    const r = await call(ctx, 'POST', '/approvals/worked-time/bulk-approve', fx.mgrA1.token, {
      ids: [clean, flagged],
    });
    expect(r.status).toBe(200);
    expect(r.body.approved).toEqual([clean]);
    expect(r.body.failed).toHaveLength(1);
    expect(r.body.failed[0].id).toBe(flagged);
    const f = await call(
      ctx,
      'GET',
      '/approvals?type=worked_time&status=pending&flag=unplanned',
      fx.mgrA1.token,
    );
    expect(f.body.items.map((i: any) => i.id)).toContain(flagged);
  });

  it('scope: a manager of another hotel cannot decide; a planner cannot decide on their own records', async () => {
    const id = await rec('tom', '2026-10-17', '2026-10-17T04:00:00Z', '2026-10-17T12:00:00Z');
    expect(
      (await call(ctx, 'PUT', `/approvals/worked-time/${id}`, fx.mgrA2.token, { decision: 'approve' }))
        .status,
    ).toBe(403);
    expect((await call(ctx, 'GET', `/approvals?hotelId=${fx.hotelA1}`, fx.mgrA2.token)).status).toBe(403);
    // make the manager's user the employee behind the record
    const m = await ctx.db
      .selectFrom('manager')
      .select('user_id')
      .where('manager_id', '=', fx.mgrA1.managerId)
      .executeTakeFirstOrThrow();
    const e = await ctx.db
      .selectFrom('employee')
      .select('user_id')
      .where('employee_id', '=', fx.emp.tom!)
      .executeTakeFirstOrThrow();
    await ctx.db
      .updateTable('employee')
      .set({ user_id: m.user_id })
      .where('employee_id', '=', fx.emp.tom!)
      .execute();
    const r = await call(ctx, 'PUT', `/approvals/worked-time/${id}`, fx.mgrA1.token, { decision: 'approve' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SELF_APPROVAL');
    await ctx.db
      .updateTable('employee')
      .set({ user_id: e.user_id })
      .where('employee_id', '=', fx.emp.tom!)
      .execute();
    expect(
      (await call(ctx, 'PUT', `/approvals/worked-time/${id}`, fx.mgrA1.token, { decision: 'approve' }))
        .status,
    ).toBe(200);
  });
});

describe('hours visibility (SPEC 4.8)', () => {
  let pending: number;
  let approved: number;
  let rejected: number;
  beforeAll(async () => {
    pending = await rec('jon', '2026-10-05', '2026-10-05T04:00:00Z', '2026-10-05T12:00:00Z');
    approved = await rec('jon', '2026-10-06', '2026-10-06T04:00:00Z', '2026-10-06T12:00:00Z', {
      approval_status: 'approved',
    });
    rejected = await rec('jon', '2026-10-07', '2026-10-07T04:00:00Z', '2026-10-07T12:00:00Z', {
      approval_status: 'rejected',
      approval_notes: 'wrong day',
    });
  });

  it('after_approval (default) hides times and hours of unapproved records, totals count approved only', async () => {
    const r = await call(ctx, 'GET', '/me/attendance?from=2026-10-05&to=2026-10-11', emp.jon!);
    expect(r.status).toBe(200);
    const byId = new Map<number, any>(r.body.items.map((i: any) => [i.id, i]));
    expect(byId.get(pending)).toEqual({
      id: pending,
      date: '2026-10-05',
      status: 'pending',
      hoursHidden: true,
    });
    expect(byId.get(rejected)).toMatchObject({
      hoursHidden: true,
      status: 'rejected',
      decisionNote: 'wrong day',
    });
    expect(byId.get(approved)).toMatchObject({ hoursHidden: false, paidHours: 7.5 });
    expect(r.body.approvedHours).toBe(7.5);
    // history is hidden together with the hours
    expect((await call(ctx, 'GET', `/me/attendance/${pending}/history`, emp.jon!)).body.items).toEqual([]);
  });

  it('immediately shows pending records as preliminary, totals still count approved only', async () => {
    const put = await call(ctx, 'PUT', `/hotels/${fx.hotelA1}/settings`, fx.adminA.token, {
      employeeHoursVisibility: 'immediately',
    });
    expect(put.status).toBe(200);
    const r = await call(ctx, 'GET', '/me/attendance?from=2026-10-05&to=2026-10-11', emp.jon!);
    const p = r.body.items.find((i: any) => i.id === pending);
    expect(p).toMatchObject({ hoursHidden: false, preliminary: true, paidHours: 7.5 });
    expect(r.body.approvedHours).toBe(7.5);
    await call(ctx, 'PUT', `/hotels/${fx.hotelA1}/settings`, fx.adminA.token, {
      employeeHoursVisibility: 'after_approval',
    });
  });

  it("an employee never sees another employee's record history", async () => {
    expect((await call(ctx, 'GET', `/me/attendance/${approved}/history`, emp.maria!)).status).toBe(404);
  });
});

describe('corrections (SPEC 4.7)', () => {
  it('validates the request per type, then approval creates a record with source=correction', async () => {
    expect(
      (await call(ctx, 'POST', '/me/corrections', emp.maria!, { type: 'missing_day', reason: 'forgot' }))
        .status,
    ).toBe(400);
    const c = await call(ctx, 'POST', '/me/corrections', emp.maria!, {
      type: 'missing_day',
      requestedIn: '2026-10-08T04:00:00Z',
      requestedOut: '2026-10-08T12:00:00Z',
      reason: 'Tablet was offline',
    });
    expect(c.status).toBe(201);
    const inbox = await call(ctx, 'GET', '/approvals?type=correction', fx.mgrA1.token);
    expect(inbox.body.items.map((i: any) => i.id)).toContain(c.body.id);
    expect(inbox.body.items[0].flags).toContain('correction');
    const d = await call(ctx, 'PUT', `/approvals/corrections/${c.body.id}`, fx.mgrA1.token, {
      decision: 'approve',
    });
    expect(d.status).toBe(200);
    const rows = await ctx.db
      .selectFrom('punch_record')
      .selectAll()
      .where('source', '=', 'correction')
      .where('employee_id', '=', fx.emp.maria!)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ approval_status: 'approved', shift_date: '2026-10-08', paid_hours: 7.5 });
    // the same range again clashes
    const c2 = await call(ctx, 'POST', '/me/corrections', emp.maria!, {
      type: 'missed_in',
      requestedIn: '2026-10-08T05:00:00Z',
      requestedOut: '2026-10-08T09:00:00Z',
      reason: 'again',
    });
    expect(
      (
        await call(ctx, 'PUT', `/approvals/corrections/${c2.body.id}`, fx.mgrA1.token, {
          decision: 'approve',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(ctx, 'PUT', `/approvals/corrections/${c2.body.id}`, fx.mgrA1.token, {
          decision: 'reject',
          notes: 'no',
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(ctx, 'GET', '/me/corrections', emp.maria!)).body.items.map((i: any) => i.status),
    ).toEqual(['rejected', 'approved']);
  });

  it('wrong_time updates only the paid fields and a record of another employee cannot be referenced', async () => {
    const id = await rec('jon', '2026-10-09', '2026-10-09T04:00:00Z', '2026-10-09T12:00:00Z', {
      approval_status: 'approved',
    });
    expect(
      (
        await call(ctx, 'POST', '/me/corrections', emp.maria!, {
          type: 'wrong_time',
          punchRecordId: id,
          requestedOut: '2026-10-09T11:00:00Z',
          reason: 'not mine',
        })
      ).status,
    ).toBe(404);
    const c = await call(ctx, 'POST', '/me/corrections', emp.jon!, {
      type: 'wrong_time',
      punchRecordId: id,
      requestedOut: '2026-10-09T11:00:00Z',
      reason: 'left earlier',
    });
    expect(c.status).toBe(201);
    await call(ctx, 'PUT', `/approvals/corrections/${c.body.id}`, fx.adminA.token, { decision: 'approve' });
    const row = await ctx.db
      .selectFrom('punch_record')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.actual_punch_out!.toISOString()).toBe('2026-10-09T12:00:00.000Z');
    expect(row.paid_end!.toISOString()).toBe('2026-10-09T11:00:00.000Z');
    expect(row.paid_hours).toBeCloseTo(6.5, 2);
    const h = await ctx.db
      .selectFrom('punch_record_history')
      .select('change_type')
      .where('punch_record_id', '=', id)
      .execute();
    expect(h.length).toBeGreaterThan(0);
  });
});

describe('vacation requests (SPEC 4.19)', () => {
  it('request -> inbox with remaining and hint -> approve -> cancel restores the allowance', async () => {
    const before = await call(ctx, 'GET', '/me/vacation', emp.maria!);
    expect(before.body).toMatchObject({ allocated: 30, used: 0, remaining: 30 });
    // Mon 2 - Fri 6 November 2026 = 5 working days
    const q = await call(ctx, 'POST', '/me/time-off-requests', emp.maria!, {
      from: '2026-11-02',
      to: '2026-11-06',
      reason: 'Trip',
    });
    expect(q.status).toBe(201);
    expect(q.body).toMatchObject({ status: 'pending', days: 5 });
    const mn = await ctx.db
      .selectFrom('notification')
      .select('kind')
      .where('kind', '=', 'vacation_requested')
      .execute();
    expect(mn.length).toBeGreaterThan(0);
    const inbox = await call(ctx, 'GET', '/approvals?type=absence', fx.mgrA1.token);
    const it = inbox.body.items.find((i: any) => i.id === q.body.id);
    expect(it).toMatchObject({ days: 5, remaining: 30, remainingAfter: 25, displayName: 'Maria T.' });
    const ok = await call(ctx, 'PUT', `/approvals/absences/${q.body.id}`, fx.mgrA1.token, {
      decision: 'approve',
    });
    expect(ok.status).toBe(200);
    expect((await call(ctx, 'GET', '/me/vacation', emp.maria!)).body).toMatchObject({
      used: 5,
      remaining: 25,
    });
    const del = await call(ctx, 'DELETE', `/me/time-off-requests/${q.body.id}`, emp.maria!);
    expect(del.status).toBe(200);
    expect((await call(ctx, 'GET', '/me/vacation', emp.maria!)).body).toMatchObject({
      used: 0,
      remaining: 30,
    });
    expect(
      (
        await ctx.db
          .selectFrom('notification')
          .select('kind')
          .where('kind', '=', 'vacation_cancelled')
          .execute()
      ).length,
    ).toBeGreaterThan(0);
  });

  it('approval cancels overlapping entries; reject sets the note; insufficient vacation is 422', async () => {
    await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.early,
      date: '2026-12-01',
    });
    await call(ctx, 'POST', '/schedule/publish', fx.adminA.token, {
      hotelIds: [fx.hotelA1],
      from: '2026-11-30',
      to: '2026-12-06',
    });
    const q = await call(ctx, 'POST', '/me/time-off-requests', emp.jon!, {
      from: '2026-12-01',
      to: '2026-12-02',
    });
    await call(ctx, 'PUT', `/approvals/absences/${q.body.id}`, fx.adminA.token, { decision: 'approve' });
    const s = await ctx.db
      .selectFrom('schedule')
      .select(['status', 'cancel_reason'])
      .where('employee_id', '=', fx.emp.jon!)
      .where('shift_date', '=', '2026-12-01')
      .executeTakeFirstOrThrow();
    expect(s).toEqual({ status: 'cancelled', cancel_reason: 'changed' });
    const q2 = await call(ctx, 'POST', '/me/time-off-requests', emp.tom!, {
      from: '2026-11-09',
      to: '2026-11-09',
    });
    const rej = await call(ctx, 'PUT', `/approvals/absences/${q2.body.id}`, fx.adminA.token, {
      decision: 'reject',
      note: 'busy week',
    });
    expect(rej.body.status).toBe('rejected');
    expect((await call(ctx, 'GET', '/me/time-off-requests', emp.tom!)).body.items[0]).toMatchObject({
      status: 'rejected',
      decisionNote: 'busy week',
    });
    const big = await call(ctx, 'POST', '/me/time-off-requests', emp.tom!, {
      from: '2027-02-01',
      to: '2027-06-30',
    });
    expect(big.status).toBe(422);
    expect(big.body.error.code).toBe('INSUFFICIENT_VACATION');
    expect(big.body.error.details.remaining).toBeTypeOf('number');
    expect(
      (await call(ctx, 'POST', '/me/time-off-requests', emp.tom!, { from: '2026-01-05', to: '2026-01-06' }))
        .status,
    ).toBe(400);
  });

  it('employees have no sick endpoint and cannot reach planner routes', async () => {
    expect((await call(ctx, 'POST', '/me/sick', emp.maria!, {})).status).toBe(404);
    expect((await call(ctx, 'GET', '/approvals', emp.maria!)).status).toBe(403);
  });
});

describe('month close (SPEC 4.11)', () => {
  it('pending approvals block the close, then closing blocks writes and reopen needs a reason', async () => {
    const pend = await rec('tom', '2026-09-10', '2026-09-10T04:00:00Z', '2026-09-10T12:00:00Z');
    const body = { companyId: fx.companyA, from: '2026-09-01', to: '2026-09-30' };
    const blocked = await call(ctx, 'POST', '/periods/close', fx.adminA.token, body);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PENDING_APPROVALS');
    expect(blocked.body.error.details.workedTime.map((x: any) => x.id)).toContain(pend);
    expect((await call(ctx, 'POST', '/periods/close', fx.mgrA1.token, body)).status).toBe(403);
    expect((await call(ctx, 'POST', '/periods/close', fx.adminB.token, body)).status).toBe(403);
    await call(ctx, 'PUT', `/approvals/worked-time/${pend}`, fx.adminA.token, { decision: 'approve' });
    const closed = await call(ctx, 'POST', '/periods/close', fx.adminA.token, body);
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed', from: '2026-09-01', to: '2026-09-30' });
    expect((await call(ctx, 'GET', '/periods', fx.adminA.token)).body.items).toHaveLength(1);
    expect((await call(ctx, 'POST', '/periods/close', fx.adminA.token, body)).status).toBe(409);
    // writes in the range fail
    const late = await rec('tom', '2026-09-11', '2026-09-11T04:00:00Z', '2026-09-11T12:00:00Z');
    const w = await call(ctx, 'PUT', `/approvals/worked-time/${late}`, fx.adminA.token, {
      decision: 'approve',
    });
    expect(w.status).toBe(409);
    expect(w.body.error.code).toBe('PERIOD_CLOSED');
    const cr = await call(ctx, 'POST', '/me/corrections', emp.tom!, {
      type: 'missing_day',
      requestedIn: '2026-09-12T04:00:00Z',
      requestedOut: '2026-09-12T12:00:00Z',
      reason: 'late',
    });
    expect(cr.body.error.code).toBe('PERIOD_CLOSED');
    const pl = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.maria,
      shiftId: fx.early,
      date: '2026-09-15',
    });
    expect(pl.body.error.code).toBe('PERIOD_CLOSED');
    // reopen
    const pid = closed.body.id;
    expect((await call(ctx, 'POST', `/periods/${pid}/reopen`, fx.adminA.token, {})).status).toBe(400);
    expect(
      (await call(ctx, 'POST', `/periods/${pid}/reopen`, fx.mgrA1.token, { reason: 'fix something' })).status,
    ).toBe(403);
    const re = await call(ctx, 'POST', `/periods/${pid}/reopen`, fx.adminA.token, {
      reason: 'late correction',
    });
    expect(re.body.status).toBe('open');
    expect(
      (await call(ctx, 'PUT', `/approvals/worked-time/${late}`, fx.adminA.token, { decision: 'approve' }))
        .status,
    ).toBe(200);
    const acts = await ctx.db
      .selectFrom('audit_log')
      .select('action')
      .where('entity_type', '=', 'payroll_period')
      .orderBy('id')
      .execute();
    expect(acts.map((a) => a.action)).toEqual(['period_closed', 'period_reopened']);
  });
});

describe('reports, audit log, notifications', () => {
  it('attendance report as JSON and CSV (BOM, semicolons)', async () => {
    const j = await call(
      ctx,
      'GET',
      `/reports/attendance?hotelId=${fx.hotelA1}&from=2026-10-01&to=2026-10-31`,
      fx.mgrA1.token,
    );
    expect(j.body.rows.length).toBeGreaterThan(3);
    const csv = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/reports/attendance?hotelId=${fx.hotelA1}&from=2026-10-01&to=2026-10-31&format=csv`,
      headers: { authorization: `Bearer ${fx.mgrA1.token}` },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    expect(csv.body.split('\r\n')[0]).toContain(';');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(
      (
        await call(
          ctx,
          'GET',
          `/reports/attendance?hotelId=${fx.hotelB1}&from=2026-10-01&to=2026-10-31`,
          fx.mgrA1.token,
        )
      ).status,
    ).toBe(403);
  });

  it('audit log filters by action and entity, exports CSV, is admin-only and company-scoped', async () => {
    const all = await call(ctx, 'GET', '/audit-log?action=period_', fx.adminA.token);
    expect(all.body.items.map((i: any) => i.action).sort()).toEqual(['period_closed', 'period_reopened']);
    expect(
      (await call(ctx, 'GET', '/audit-log?entity=punch_record', fx.adminA.token)).body.total,
    ).toBeGreaterThan(0);
    expect((await call(ctx, 'GET', '/audit-log', fx.mgrA1.token)).status).toBe(403);
    expect((await call(ctx, 'GET', '/audit-log?action=period_', fx.adminB.token)).body.items).toEqual([]);
    const csv = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit-log?format=csv',
      headers: { authorization: `Bearer ${fx.adminA.token}` },
    });
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
  });

  it('notifications can be listed and marked read, only by their owner', async () => {
    const list = await call(ctx, 'GET', '/notifications', emp.maria!);
    expect(list.body.unread).toBeGreaterThan(0);
    const first = list.body.items[0];
    expect((await call(ctx, 'PUT', `/notifications/${first.id}/read`, emp.jon!)).status).toBe(404);
    expect((await call(ctx, 'PUT', `/notifications/${first.id}/read`, emp.maria!)).status).toBe(200);
    expect((await call(ctx, 'GET', '/notifications', emp.maria!)).body.unread).toBe(list.body.unread - 1);
    const mgr = await call(ctx, 'GET', '/approvals/count', fx.mgrA1.token);
    expect(mgr.body.total).toBeTypeOf('number');
  });

  it('me/home and me/schedule give the portal data', async () => {
    at('2026-10-20T10:00:00Z');
    const h = await call(ctx, 'GET', '/me/home', emp.maria!);
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ today: '2026-10-20', targetHours: 40 });
    expect(h.body.vacation.remaining).toBe(30);
    expect(Array.isArray(h.body.nextShifts)).toBe(true);
    const s = await call(ctx, 'GET', '/me/schedule?from=2026-11-30&to=2026-12-06', emp.jon!);
    expect(s.body.absences[0]).toMatchObject({ type: 'annual_leave', status: 'approved' });
    expect((await call(ctx, 'GET', '/me/time-account', emp.maria!)).body.balanceHours).toBeTypeOf('number');
  });
});

describe('request preview', () => {
  it('counts days on the server and shows the remaining allowance', async () => {
    const r = await call(
      ctx,
      'GET',
      '/me/time-off-requests/preview?from=2026-11-16&to=2026-11-20',
      emp.maria!,
    );
    expect(r.body).toMatchObject({ days: 5, remaining: 30, remainingAfter: 25, sufficient: true });
    const big = await call(
      ctx,
      'GET',
      '/me/time-off-requests/preview?from=2027-02-01&to=2027-06-30',
      emp.maria!,
    );
    expect(big.body.sufficient).toBe(false);
  });
});
