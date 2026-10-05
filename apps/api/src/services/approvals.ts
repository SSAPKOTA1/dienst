import { addDays, countedDays, paidHours, requiredBreakMinutes, withinGrace } from '@dienst/rules';
import type { Db, DbOrTrx, Trx } from '../db';
import { AppError, notFound } from '../lib/errors';
import { audit, type Actor } from '../lib/audit';
import type { Principal } from '../lib/scope';
import { localDate } from '../lib/time';
import { resolveHolidays } from './holidays';
import { notifyEmployee } from './planning/ops';
import { paidFor } from './kiosk';
import { ensureAllowance, remainingDays } from './vacation';
import { loadStaffing, requiredOn } from './staffing';

export const deciderRole = (p: Principal) =>
  p.role === 'superAdmin' ? 'super_admin' : (p.role as 'admin' | 'manager');

export async function assertNotClosed(db: DbOrTrx, companyId: number, hotelId: number, date: string) {
  const c = await db
    .selectFrom('payroll_period')
    .select('id')
    .where('company_id', '=', companyId)
    .where('status', '=', 'closed')
    .where('period_start', '<=', date)
    .where('period_end', '>=', date)
    .where((eb) => eb.or([eb('hotel_id', 'is', null), eb('hotel_id', '=', hotelId)]))
    .executeTakeFirst();
  if (c) throw new AppError('PERIOD_CLOSED', 'The payroll period is closed', { date });
}

/** SPEC 2.3: a planner may not decide on records of their own employee row(s). */
export function assertNotSelf(p: Principal, employeeUserId: number) {
  if (employeeUserId === p.userId)
    throw new AppError('SELF_APPROVAL', 'You cannot decide on your own records');
}

export type Flag =
  'variation' | 'unplanned' | 'auto_checkout' | 'under_break' | 'correction' | 'offline' | 'web';

export function flagsOf(
  r: {
    is_unplanned: boolean;
    auto_checked_out: boolean;
    under_break_warning: boolean;
    source: string;
    offline_punch?: boolean;
  },
  variations: Array<{ variation_type: string; status: string }>,
): Flag[] {
  const f: Flag[] = [];
  if (variations.some((v) => v.variation_type !== 'unplanned' && v.status === 'pending')) f.push('variation');
  if (r.is_unplanned) f.push('unplanned');
  if (r.auto_checked_out) f.push('auto_checkout');
  if (r.under_break_warning) f.push('under_break');
  if (r.source === 'correction') f.push('correction');
  if (r.offline_punch || r.source === 'kiosk_offline') f.push('offline');
  if (r.source === 'web') f.push('web');
  return f;
}

export interface WorkedItem {
  id: number;
  type: 'worked_time';
  hotelId: number;
  employeeId: number;
  displayName: string;
  shiftDate: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualIn: string;
  actualOut: string | null;
  paidStart: string | null;
  paidEnd: string | null;
  breakMinutes: number | null;
  requiredBreakMinutes: number | null;
  paidHours: number | null;
  flags: Flag[];
  variations: Array<{ type: string; minutes: number | null; reason: string | null; status: string }>;
  status: string;
  notes: string | null;
  ageDays: number;
  overdue: boolean;
}

export async function listWorkedTime(
  db: Db,
  hotelIds: number[],
  q: { status?: string; from?: string; to?: string; employeeId?: number },
  today: string,
  flagFilter?: string,
): Promise<WorkedItem[]> {
  if (!hotelIds.length) return [];
  let qb = db
    .selectFrom('punch_record as p')
    .innerJoin('employee as e', 'e.employee_id', 'p.employee_id')
    .select([
      'p.id',
      'p.hotel_id',
      'p.employee_id',
      'e.display_name',
      'p.shift_date',
      'p.planned_start',
      'p.planned_end',
      'p.actual_punch_in',
      'p.actual_punch_out',
      'p.paid_start',
      'p.paid_end',
      'p.actual_break_minutes',
      'p.required_break_minutes',
      'p.paid_hours',
      'p.is_unplanned',
      'p.auto_checked_out',
      'p.under_break_warning',
      'p.offline_punch',
      'p.source',
      'p.approval_status',
      'p.approval_notes',
    ])
    .where('p.hotel_id', 'in', hotelIds)
    .where('p.actual_punch_out', 'is not', null)
    .orderBy('p.shift_date', 'desc')
    .orderBy('p.id', 'desc')
    .limit(500);
  if (q.status) qb = qb.where('p.approval_status', '=', q.status);
  if (q.from) qb = qb.where('p.shift_date', '>=', q.from);
  if (q.to) qb = qb.where('p.shift_date', '<=', q.to);
  if (q.employeeId) qb = qb.where('p.employee_id', '=', q.employeeId);
  const rows = await qb.execute();
  const vars = rows.length
    ? await db
        .selectFrom('time_variation')
        .selectAll()
        .where(
          'punch_record_id',
          'in',
          rows.map((r) => r.id),
        )
        .orderBy('id')
        .execute()
    : [];
  const out = rows.map((r) => {
    const v = vars.filter((x) => x.punch_record_id === r.id);
    const age = Math.max(0, Math.round((Date.parse(today) - Date.parse(r.shift_date)) / 86400000));
    return {
      id: r.id,
      type: 'worked_time' as const,
      hotelId: r.hotel_id,
      employeeId: r.employee_id,
      displayName: r.display_name ?? '',
      shiftDate: r.shift_date,
      plannedStart: r.planned_start?.toISOString() ?? null,
      plannedEnd: r.planned_end?.toISOString() ?? null,
      actualIn: r.actual_punch_in.toISOString(),
      actualOut: r.actual_punch_out?.toISOString() ?? null,
      paidStart: r.paid_start?.toISOString() ?? null,
      paidEnd: r.paid_end?.toISOString() ?? null,
      breakMinutes: r.actual_break_minutes,
      requiredBreakMinutes: r.required_break_minutes,
      paidHours: r.paid_hours,
      flags: flagsOf(r, v),
      variations: v.map((x) => ({
        type: x.variation_type,
        minutes: x.variation_minutes,
        reason: x.reason,
        status: x.status,
      })),
      status: r.approval_status,
      notes: r.approval_notes,
      ageDays: age,
      overdue: r.approval_status === 'pending' && age > 5,
    };
  });
  return flagFilter ? out.filter((i) => i.flags.includes(flagFilter as Flag)) : out;
}

export async function decideWorkedTime(
  trx: Trx,
  p: Principal,
  actor: Actor,
  now: Date,
  id: number,
  d: {
    decision: 'approve' | 'reject';
    paidStart?: string;
    paidEnd?: string;
    breakMinutes?: number;
    notes?: string;
  },
  opts: { requirePending?: boolean } = {},
) {
  const rec = await trx
    .selectFrom('punch_record')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (!rec) throw notFound('Time record');
  p.scope.assertHotel(rec.hotel_id);
  const emp = await trx
    .selectFrom('employee')
    .select(['employee_id', 'user_id', 'company_id'])
    .where('employee_id', '=', rec.employee_id)
    .executeTakeFirstOrThrow();
  assertNotSelf(p, emp.user_id);
  if (!rec.actual_punch_out) throw new AppError('CONFLICT', 'The record is still open; close it first');
  if (rec.approval_status !== 'pending' && opts.requirePending !== false)
    throw new AppError('CONFLICT', 'The record was already decided');
  await assertNotClosed(trx, emp.company_id, rec.hotel_id, rec.shift_date);
  const old = {
    paid_start: rec.paid_start?.toISOString() ?? null,
    paid_end: rec.paid_end?.toISOString() ?? null,
    actual_break_minutes: rec.actual_break_minutes,
    paid_hours: rec.paid_hours,
    approval_status: rec.approval_status,
  };
  let patch: Record<string, unknown>;
  if (d.decision === 'approve') {
    const paidStart = d.paidStart ? new Date(d.paidStart) : (rec.paid_start ?? rec.actual_punch_in);
    const paidEnd = d.paidEnd ? new Date(d.paidEnd) : (rec.paid_end ?? rec.actual_punch_out);
    if (paidEnd <= paidStart) throw new AppError('VALIDATION', 'paidEnd must be after paidStart');
    const gross = Math.floor((paidEnd.getTime() - paidStart.getTime()) / 60000);
    const brk = d.breakMinutes ?? rec.actual_break_minutes ?? requiredBreakMinutes(gross);
    patch = {
      paid_start: paidStart,
      paid_end: paidEnd,
      actual_break_minutes: brk,
      paid_hours: paidFor(paidStart, paidEnd, brk),
      approval_status: 'approved',
    };
  } else if (rec.planned_start && rec.planned_end && !rec.is_unplanned) {
    const gross = Math.floor((rec.planned_end.getTime() - rec.planned_start.getTime()) / 60000);
    const brk = requiredBreakMinutes(gross);
    patch = {
      paid_start: rec.planned_start,
      paid_end: rec.planned_end,
      actual_break_minutes: brk,
      paid_hours: paidHours(gross, brk),
      approval_status: 'rejected',
    };
  } else {
    patch = { paid_start: null, paid_end: null, paid_hours: 0, approval_status: 'rejected' };
  }
  const upd = await trx
    .updateTable('punch_record')
    .set({
      ...patch,
      approval_source: 'manual',
      approved_by_user_id: p.userId,
      approved_by_role: deciderRole(p),
      approved_at: now,
      approval_notes: d.notes ?? null,
      updated_at: now,
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await trx
    .updateTable('time_variation')
    .set({
      status: d.decision === 'approve' ? 'approved' : 'rejected',
      reviewed_by_user_id: p.userId,
      reviewed_by_role: deciderRole(p),
      review_notes: d.notes ?? null,
      reviewed_at: now,
      updated_at: now,
    })
    .where('punch_record_id', '=', id)
    .where('status', '=', 'pending')
    .execute();
  await trx
    .insertInto('punch_record_history')
    .values({
      punch_record_id: id,
      changed_by_user_id: p.userId,
      changed_by_role: deciderRole(p),
      change_type: d.decision === 'approve' ? 'approved' : 'rejected',
      old_values: JSON.stringify(old),
      new_values: JSON.stringify({
        paid_start: upd.paid_start?.toISOString() ?? null,
        paid_end: upd.paid_end?.toISOString() ?? null,
        actual_break_minutes: upd.actual_break_minutes,
        paid_hours: upd.paid_hours,
        approval_status: upd.approval_status,
      }),
      reason: d.notes ?? null,
    })
    .execute();
  await notifyEmployee(trx, { id: emp.employee_id, userId: emp.user_id }, 'approval_decision', {
    punchRecordId: id,
    decision: d.decision,
    date: rec.shift_date,
    note: d.notes ?? null,
  });
  await audit(trx, actor, {
    action: d.decision === 'approve' ? 'worked_time_approved' : 'worked_time_rejected',
    entityType: 'punch_record',
    entityId: id,
    hotelId: rec.hotel_id,
    companyId: emp.company_id,
    old,
    new: { paidHours: upd.paid_hours, adjusted: !!(d.paidStart || d.paidEnd || d.breakMinutes != null) },
    reason: d.notes ?? null,
  });
  return { id, status: upd.approval_status, paidHours: upd.paid_hours };
}

// ---------------------------------------------------------------------------------------------
// corrections

export async function decideCorrection(
  trx: Trx,
  p: Principal,
  actor: Actor,
  now: Date,
  id: number,
  d: { decision: 'approve' | 'reject'; notes?: string },
) {
  const c = await trx
    .selectFrom('time_correction_request')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (!c) throw notFound('Correction request');
  p.scope.assertHotel(c.hotel_id);
  const emp = await trx
    .selectFrom('employee')
    .select(['employee_id', 'user_id', 'company_id'])
    .where('employee_id', '=', c.employee_id)
    .executeTakeFirstOrThrow();
  assertNotSelf(p, emp.user_id);
  if (c.status !== 'pending') throw new AppError('CONFLICT', 'The request was already decided');
  const hotel = await trx
    .selectFrom('hotel')
    .select('timezone')
    .where('id', '=', c.hotel_id)
    .executeTakeFirstOrThrow();
  const refDate = localDate(c.requested_in ?? c.requested_out ?? now, hotel.timezone);
  let recDate = refDate;
  if (c.punch_record_id)
    recDate = (
      await trx
        .selectFrom('punch_record')
        .select('shift_date')
        .where('id', '=', c.punch_record_id)
        .executeTakeFirstOrThrow()
    ).shift_date;
  await assertNotClosed(trx, emp.company_id, c.hotel_id, recDate);
  let recordId: number | null = c.punch_record_id;
  if (d.decision === 'approve') {
    const brkReq = c.requested_break_minutes;
    if (c.correction_type === 'wrong_time' || c.correction_type === 'missed_out') {
      if (!c.punch_record_id) throw new AppError('VALIDATION', 'The request has no time record');
      const rec = await trx
        .selectFrom('punch_record')
        .selectAll()
        .where('id', '=', c.punch_record_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const paidStart = c.requested_in ?? rec.paid_start ?? rec.actual_punch_in;
      const paidEnd = c.requested_out ?? rec.paid_end ?? rec.actual_punch_out;
      if (!paidEnd || paidEnd <= paidStart)
        throw new AppError('VALIDATION', 'The requested times are not valid');
      const brk =
        brkReq ??
        rec.actual_break_minutes ??
        requiredBreakMinutes(Math.floor((paidEnd.getTime() - paidStart.getTime()) / 60000));
      const set: Record<string, unknown> = {
        paid_start: paidStart,
        paid_end: paidEnd,
        actual_break_minutes: brk,
        paid_hours: paidFor(paidStart, paidEnd, brk),
        approval_status: 'approved',
        approval_source: 'manual',
        approved_by_user_id: p.userId,
        approved_by_role: deciderRole(p),
        approved_at: now,
        approval_notes: d.notes ?? null,
        updated_at: now,
      };
      if (!rec.actual_punch_out) set.actual_punch_out = paidEnd; // an open record is completed; recorded actual times are never overwritten
      await trx.updateTable('punch_record').set(set).where('id', '=', rec.id).execute();
      await trx
        .updateTable('time_variation')
        .set({
          status: 'approved',
          reviewed_by_user_id: p.userId,
          reviewed_by_role: deciderRole(p),
          reviewed_at: now,
        })
        .where('punch_record_id', '=', rec.id)
        .where('status', '=', 'pending')
        .execute();
      await trx
        .insertInto('punch_record_history')
        .values({
          punch_record_id: rec.id,
          changed_by_user_id: p.userId,
          changed_by_role: deciderRole(p),
          change_type: 'correction_approved',
          old_values: JSON.stringify({
            paid_start: rec.paid_start?.toISOString() ?? null,
            paid_end: rec.paid_end?.toISOString() ?? null,
            actual_break_minutes: rec.actual_break_minutes,
          }),
          new_values: JSON.stringify({
            paid_start: paidStart.toISOString(),
            paid_end: paidEnd.toISOString(),
            actual_break_minutes: brk,
          }),
          reason: c.reason,
        })
        .execute();
    } else {
      // missed_in / missing_day: insert a record with the requested times
      if (!c.requested_in || !c.requested_out || c.requested_out <= c.requested_in)
        throw new AppError('VALIDATION', 'The request needs a start and an end time');
      const overlap = await trx
        .selectFrom('punch_record')
        .select('id')
        .where('employee_id', '=', c.employee_id)
        .where('approval_status', '<>', 'rejected')
        .where('actual_punch_in', '<', c.requested_out)
        .where((eb) =>
          eb.or([eb('actual_punch_out', 'is', null), eb('actual_punch_out', '>', c.requested_in!)]),
        )
        .limit(1)
        .executeTakeFirst();
      if (overlap)
        throw new AppError('CONFLICT', 'A time record already exists for this period', {
          punchRecordId: overlap.id,
        });
      const brk =
        brkReq ??
        requiredBreakMinutes(Math.floor((c.requested_out.getTime() - c.requested_in.getTime()) / 60000));
      const sched = await trx
        .selectFrom('schedule')
        .select(['id', 'planned_start', 'planned_end'])
        .where('employee_id', '=', c.employee_id)
        .where('hotel_id', '=', c.hotel_id)
        .where('status', '=', 'published')
        .where('shift_date', '=', refDate)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('punch_record as pr')
                .select('pr.id')
                .whereRef('pr.schedule_id', '=', 'schedule.id')
                .where('pr.approval_status', '<>', 'rejected'),
            ),
          ),
        )
        .executeTakeFirst();
      const ins = await trx
        .insertInto('punch_record')
        .values({
          employee_id: c.employee_id,
          hotel_id: c.hotel_id,
          schedule_id: sched?.id ?? null,
          is_unplanned: !sched,
          shift_date: refDate,
          source: 'correction',
          planned_start: sched?.planned_start ?? null,
          planned_end: sched?.planned_end ?? null,
          actual_punch_in: c.requested_in,
          actual_punch_out: c.requested_out,
          paid_start: c.requested_in,
          paid_end: c.requested_out,
          required_break_minutes: requiredBreakMinutes(
            Math.floor((c.requested_out.getTime() - c.requested_in.getTime()) / 60000),
          ),
          actual_break_minutes: brk,
          paid_hours: paidFor(c.requested_in, c.requested_out, brk),
          approval_status: 'approved',
          approval_source: 'manual',
          approved_by_user_id: p.userId,
          approved_by_role: deciderRole(p),
          approved_at: now,
          approval_notes: d.notes ?? null,
          created_by_user_id: p.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      recordId = ins.id;
      await trx
        .insertInto('punch_record_history')
        .values({
          punch_record_id: ins.id,
          changed_by_user_id: p.userId,
          changed_by_role: deciderRole(p),
          change_type: 'correction_created',
          new_values: JSON.stringify({
            requested_in: c.requested_in.toISOString(),
            requested_out: c.requested_out.toISOString(),
            actual_break_minutes: brk,
          }),
          reason: c.reason,
        })
        .execute();
    }
  }
  await trx
    .updateTable('time_correction_request')
    .set({
      status: d.decision === 'approve' ? 'approved' : 'rejected',
      decided_by_user_id: p.userId,
      decided_by_role: deciderRole(p),
      decision_notes: d.notes ?? null,
      decided_at: now,
      punch_record_id: recordId,
    })
    .where('id', '=', id)
    .execute();
  await notifyEmployee(trx, { id: emp.employee_id, userId: emp.user_id }, 'approval_decision', {
    correctionId: id,
    decision: d.decision,
    note: d.notes ?? null,
  });
  await audit(trx, actor, {
    action: d.decision === 'approve' ? 'correction_approved' : 'correction_rejected',
    entityType: 'time_correction_request',
    entityId: id,
    hotelId: c.hotel_id,
    companyId: emp.company_id,
    new: { type: c.correction_type, punchRecordId: recordId },
    reason: d.notes ?? null,
  });
  return { id, status: d.decision === 'approve' ? 'approved' : 'rejected', punchRecordId: recordId };
}

// ---------------------------------------------------------------------------------------------
// vacation requests

export async function vacationDays(trx: DbOrTrx, employeeId: number, from: string, to: string) {
  const emp = await trx
    .selectFrom('employee')
    .select(['primary_hotel_id'])
    .where('employee_id', '=', employeeId)
    .executeTakeFirstOrThrow();
  const contract = await trx
    .selectFrom('employee_contract')
    .select(['working_weekdays'])
    .where('employee_id', '=', employeeId)
    .where('valid_from', '<=', to)
    .orderBy('valid_from', 'desc')
    .limit(1)
    .executeTakeFirst();
  const holidays = new Set((await resolveHolidays(trx, emp.primary_hotel_id, from, to)).keys());
  return countedDays(from, to, contract?.working_weekdays ?? [1, 2, 3, 4, 5], holidays);
}

/** Days of the request where the employee's department would drop below the requirement (SPEC 4.19 hint). */
export async function understaffingHint(db: DbOrTrx, employeeId: number, days: string[]) {
  const e = await db
    .selectFrom('employee')
    .select(['primary_hotel_id', 'primary_department_id'])
    .where('employee_id', '=', employeeId)
    .executeTakeFirstOrThrow();
  const shifts = await db
    .selectFrom('shift')
    .select('id')
    .where('department_id', '=', e.primary_department_id)
    .execute();
  if (!shifts.length || !days.length) return [];
  const staffing = await loadStaffing(
    db,
    shifts.map((s) => s.id),
  );
  const dept = await db
    .selectFrom('department')
    .select('name')
    .where('id', '=', e.primary_department_id)
    .executeTakeFirstOrThrow();
  const rows = await db
    .selectFrom('schedule')
    .select(['shift_date', 'employee_id'])
    .where(
      'shift_id',
      'in',
      shifts.map((s) => s.id),
    )
    .where('status', '<>', 'cancelled')
    .where('shift_date', 'in', days)
    .execute();
  const out: Array<{ date: string; departmentName: string; assigned: number; required: number }> = [];
  for (const d of days) {
    const required = shifts.reduce((a, s) => a + requiredOn(staffing.get(s.id), d), 0);
    const others = new Set(
      rows.filter((r) => r.shift_date === d && r.employee_id !== employeeId).map((r) => r.employee_id),
    ).size;
    if (required > 0 && others < required)
      out.push({ date: d, departmentName: dept.name, assigned: others, required });
  }
  return out;
}

export async function decideAbsence(
  trx: Trx,
  p: Principal,
  actor: Actor,
  now: Date,
  id: number,
  d: { decision: 'approve' | 'reject'; note?: string },
) {
  const t = await trx.selectFrom('time_off').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  if (!t) throw notFound('Request');
  const emp = await trx
    .selectFrom('employee')
    .select(['employee_id', 'user_id', 'company_id', 'primary_hotel_id'])
    .where('employee_id', '=', t.employee_id)
    .executeTakeFirstOrThrow();
  const hs = await trx
    .selectFrom('employee_hotel')
    .select('hotel_id')
    .where('employee_id', '=', emp.employee_id)
    .execute();
  const hotels = new Set([emp.primary_hotel_id, ...hs.map((h) => h.hotel_id)]);
  if (![...hotels].some((h) => p.scope.canHotel(h)))
    throw new AppError('FORBIDDEN_SCOPE', 'Outside your hotels');
  assertNotSelf(p, emp.user_id);
  if (t.status !== 'pending') throw new AppError('CONFLICT', 'The request was already decided');
  for (const h of hotels) {
    for (let day = t.start_date; day <= t.end_date; day = addDays(day, 1))
      await assertNotClosed(trx, emp.company_id, h, day);
  }
  if (d.decision === 'reject') {
    await trx
      .updateTable('time_off')
      .set({
        status: 'rejected',
        decided_by_user_id: p.userId,
        decided_at: now,
        decision_note: d.note ?? null,
        updated_at: now,
      })
      .where('id', '=', id)
      .execute();
  } else {
    const days = await vacationDays(trx, emp.employee_id, t.start_date, t.end_date);
    const perYear = new Map<number, number>();
    for (const x of days)
      perYear.set(Number(x.slice(0, 4)), (perYear.get(Number(x.slice(0, 4))) ?? 0) + (t.half_day ? 0.5 : 1));
    for (const [year, n] of perYear) {
      const a = await ensureAllowance(trx, emp.employee_id, year);
      if (remainingDays(a) < n)
        throw new AppError('INSUFFICIENT_VACATION', 'Not enough vacation left', {
          remaining: remainingDays(a),
          days: n,
        });
      await trx
        .updateTable('employee_vacation_allowance')
        .set({ used_days: a.used_days + n, updated_at: now })
        .where('id', '=', a.id)
        .execute();
    }
    await trx
      .updateTable('time_off')
      .set({
        status: 'approved',
        decided_by_user_id: p.userId,
        decided_at: now,
        decision_note: d.note ?? null,
        time_off_days: t.half_day ? 0.5 : days.length,
        updated_at: now,
      })
      .where('id', '=', id)
      .execute();
    // a half day leaves the entries of the day in place
    const cancelled = t.half_day
      ? []
      : await trx
          .updateTable('schedule')
          .set((eb) => ({
            status: 'cancelled',
            cancel_reason: 'changed',
            time_off_id: id,
            version: eb('version', '+', 1),
            updated_at: now,
          }))
          .where('employee_id', '=', emp.employee_id)
          .where('status', '<>', 'cancelled')
          .where('shift_date', '>=', t.start_date)
          .where('shift_date', '<=', t.end_date)
          .returning(['id', 'published_at'])
          .execute();
    const pub = cancelled.filter((c) => c.published_at);
    if (pub.length)
      await notifyEmployee(trx, { id: emp.employee_id, userId: emp.user_id }, 'schedule_changed', {
        entryIds: pub.map((c) => c.id),
        change: 'removed',
        reason: 'annual_leave',
      });
  }
  await notifyEmployee(trx, { id: emp.employee_id, userId: emp.user_id }, 'approval_decision', {
    timeOffId: id,
    decision: d.decision,
    note: d.note ?? null,
    from: t.start_date,
    to: t.end_date,
  });
  await audit(trx, actor, {
    action: d.decision === 'approve' ? 'absence_approved' : 'absence_rejected',
    entityType: 'time_off',
    entityId: id,
    hotelId: emp.primary_hotel_id,
    companyId: emp.company_id,
    new: { from: t.start_date, to: t.end_date },
    reason: d.note ?? null,
  });
  return { id, status: d.decision === 'approve' ? 'approved' : 'rejected' };
}

export { withinGrace };
