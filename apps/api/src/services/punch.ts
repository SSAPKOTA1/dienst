import { variationMinutes, withinGrace } from '@dienst/rules';
import type { Trx } from '../db';
import { AppError } from '../lib/errors';
import { audit, type Actor } from '../lib/audit';
import { localDate } from '../lib/time';
import { computeClose, matchSchedule, paidFor } from './kiosk';

export type PunchSource = 'kiosk' | 'kiosk_offline' | 'web';

export interface PunchWho {
  empId: number;
  userId: number;
  companyId: number;
}

const actorFor = (userId: number): Actor => ({ userId, type: 'employee' });

export type BreakSegment = { start: string; end: string | null };

/** SPEC (backlog): only breaks of at least 15 minutes count towards the legal break. */
export const MIN_SEGMENT_MINUTES = 15;

export function segmentMinutes(segments: BreakSegment[] | null | undefined, until: Date): number {
  let total = 0;
  for (const s of segments ?? []) {
    const end = s.end ? new Date(s.end) : until;
    const m = Math.floor((end.getTime() - new Date(s.start).getTime()) / 60000);
    if (m >= MIN_SEGMENT_MINUTES) total += m;
  }
  return total;
}

export async function assertPeriodOpen(trx: Trx, companyId: number, hotelId: number | null, date: string) {
  const closed = await trx
    .selectFrom('payroll_period')
    .select('id')
    .where('company_id', '=', companyId)
    .where('status', '=', 'closed')
    .where('period_start', '<=', date)
    .where('period_end', '>=', date)
    .$if(hotelId != null, (q) =>
      q.where((eb) => eb.or([eb('hotel_id', 'is', null), eb('hotel_id', '=', hotelId!)])),
    )
    .executeTakeFirst();
  if (closed) throw new AppError('PERIOD_CLOSED', 'The payroll period is closed');
}

/** Clock-in shared by the tablet, queued offline punches and the web punch. Returns the open record. */
export async function punchIn(
  trx: Trx,
  p: PunchWho & {
    hotelId: number;
    at: Date;
    now: Date;
    source: PunchSource;
    deviceId: number | null;
    grace: number;
    tz: string;
    /** client address, kept in the audit entry of web punches */
    ip?: string;
  },
) {
  const open = await trx
    .selectFrom('punch_record')
    .selectAll()
    .where('employee_id', '=', p.empId)
    .where('actual_punch_out', 'is', null)
    .executeTakeFirst();
  if (open) {
    if (Math.abs(p.at.getTime() - open.actual_punch_in.getTime()) < 60e3)
      return { rec: open, duplicate: true };
    throw new AppError('ALREADY_CLOCKED_IN', 'Already clocked in', {
      since: open.actual_punch_in.toISOString(),
    });
  }
  const match = await matchSchedule(trx, p.hotelId, p.empId, p.at);
  const shiftDate = localDate(match ? match.planned_start : p.at, p.tz);
  await assertPeriodOpen(trx, p.companyId, p.hotelId, shiftDate);
  let variation: number | null = null;
  let paidStart = p.at;
  let outside = false;
  if (match) {
    variation = variationMinutes(p.at.toISOString(), match.planned_start.toISOString());
    outside = !withinGrace(variation, p.grace);
    if (!outside) paidStart = match.planned_start;
  }
  const rec = await trx
    .insertInto('punch_record')
    .values({
      employee_id: p.empId,
      hotel_id: p.hotelId,
      schedule_id: match?.id ?? null,
      is_unplanned: !match,
      shift_date: shiftDate,
      source: p.source,
      kiosk_device_id: p.deviceId,
      planned_start: match?.planned_start ?? null,
      planned_end: match?.planned_end ?? null,
      actual_punch_in: p.at,
      paid_start: paidStart,
      start_variation_minutes: variation,
      offline_punch: p.source === 'kiosk_offline',
      approval_status: 'pending',
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (!match || outside) {
    await trx
      .insertInto('time_variation')
      .values({
        punch_record_id: rec.id,
        employee_id: p.empId,
        hotel_id: p.hotelId,
        variation_type: !match ? 'unplanned' : variation! < 0 ? 'clock_in_early' : 'clock_in_late',
        planned_time: match?.planned_start ?? null,
        actual_time: p.at,
        variation_minutes: variation,
      })
      .execute();
  }
  await trx
    .insertInto('punch_record_history')
    .values({
      punch_record_id: rec.id,
      changed_by_user_id: p.userId,
      changed_by_role: 'employee',
      change_type: 'clock_in',
      new_values: JSON.stringify({
        actual_punch_in: p.at.toISOString(),
        unplanned: !match,
        source: p.source,
      }),
    })
    .execute();
  await audit(trx, actorFor(p.userId), {
    action: 'punch_in',
    entityType: 'punch_record',
    entityId: rec.id,
    hotelId: p.hotelId,
    companyId: p.companyId,
    new: {
      deviceId: p.deviceId,
      source: p.source,
      unplanned: !match,
      variationMinutes: variation,
      ...(p.ip ? { ip: p.ip } : {}),
    },
  });
  return { rec, duplicate: false };
}

export interface CloseResult {
  status: 'clocked_out' | 'clocked_out_with_warning';
  paidHours: number;
  approvalStatus: string;
}

/** Clock-out shared by the tablet confirmation, queued offline punches and the web punch. */
export async function closePunch(
  trx: Trx,
  p: PunchWho & {
    recordId: number;
    hotelId: number | null; // when set, the record must belong to this hotel
    outAt: Date;
    now: Date;
    grace: number;
    breakMinutes: number;
    reason?: string;
    forceReview?: boolean;
    offline?: boolean;
    source?: PunchSource;
    ip?: string;
  },
): Promise<CloseResult> {
  const rec = await trx
    .selectFrom('punch_record')
    .selectAll()
    .where('id', '=', p.recordId)
    .forUpdate()
    .executeTakeFirst();
  if (!rec || (p.hotelId != null && rec.hotel_id !== p.hotelId) || rec.employee_id !== p.empId)
    throw new AppError('NOT_FOUND', 'Time record not found');
  if (rec.actual_punch_out) {
    if (rec.actual_punch_out.getTime() === p.outAt.getTime())
      return {
        status: rec.under_break_warning ? 'clocked_out_with_warning' : 'clocked_out',
        paidHours: rec.paid_hours ?? 0,
        approvalStatus: rec.approval_status,
      }; // idempotent confirm
    throw new AppError('CONFLICT', 'The record is already closed');
  }
  const cl = computeClose(rec, p.outAt, p.grace);
  const brk = p.breakMinutes;
  const under = brk < cl.requiredBreak;
  const reason = p.reason?.trim() || null;
  if (under && !reason)
    throw new AppError('REASON_REQUIRED', 'A reason is required when the break is shorter than required', {
      requiredBreakMinutes: cl.requiredBreak,
    });
  await assertPeriodOpen(trx, p.companyId, null, rec.shift_date);
  const startOutside =
    rec.is_unplanned ||
    (rec.start_variation_minutes != null && !withinGrace(rec.start_variation_minutes, p.grace));
  const flagged = startOutside || cl.outsideGrace || under || !!p.forceReview || rec.offline_punch;
  const hours = paidFor(cl.paidStart, cl.paidEnd, brk);
  // an open break segment ends with the shift
  const segs = (rec.break_segments as BreakSegment[] | null) ?? null;
  const closedSegs = segs?.map((s) => (s.end ? s : { ...s, end: p.outAt.toISOString() })) ?? null;
  await trx
    .updateTable('punch_record')
    .set({
      actual_punch_out: p.outAt,
      paid_start: cl.paidStart,
      paid_end: cl.paidEnd,
      end_variation_minutes: cl.endVariation,
      required_break_minutes: cl.requiredBreak,
      actual_break_minutes: brk,
      break_segments: closedSegs ? JSON.stringify(closedSegs) : null,
      paid_hours: hours,
      under_break_warning: under,
      offline_punch: rec.offline_punch || !!p.offline,
      approval_status: flagged ? 'pending' : 'approved',
      approval_source: flagged ? null : 'auto',
      approved_at: flagged ? null : p.now,
      updated_at: p.now,
    })
    .where('id', '=', rec.id)
    .execute();
  if (cl.outsideGrace) {
    await trx
      .insertInto('time_variation')
      .values({
        punch_record_id: rec.id,
        employee_id: rec.employee_id,
        hotel_id: rec.hotel_id,
        variation_type: cl.endVariation! < 0 ? 'clock_out_early' : 'clock_out_late',
        planned_time: rec.planned_end,
        actual_time: p.outAt,
        variation_minutes: cl.endVariation,
        reason,
      })
      .execute();
  }
  if (under)
    await trx
      .updateTable('time_variation')
      .set({ reason })
      .where('punch_record_id', '=', rec.id)
      .where('reason', 'is', null)
      .execute();
  const user = await trx
    .selectFrom('employee')
    .select('user_id')
    .where('employee_id', '=', p.empId)
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('punch_record_history')
    .values({
      punch_record_id: rec.id,
      changed_by_user_id: user.user_id,
      changed_by_role: 'employee',
      change_type: 'clock_out',
      new_values: JSON.stringify({
        actual_punch_out: p.outAt.toISOString(),
        actual_break_minutes: brk,
        paid_hours: hours,
        source: p.source ?? null,
      }),
      reason,
    })
    .execute();
  await audit(trx, actorFor(user.user_id), {
    action: 'punch_out',
    entityType: 'punch_record',
    entityId: rec.id,
    hotelId: rec.hotel_id,
    companyId: p.companyId,
    new: {
      paidHours: hours,
      breakMinutes: brk,
      flagged,
      underBreak: under,
      source: p.source ?? null,
      ...(p.ip ? { ip: p.ip } : {}),
    },
    reason,
  });
  return {
    status: under ? 'clocked_out_with_warning' : 'clocked_out',
    paidHours: hours,
    approvalStatus: flagged ? 'pending' : 'approved',
  };
}

/** Start/stop break mode: adds an open segment, or closes it. */
export async function breakToggle(
  trx: Trx,
  p: PunchWho & { hotelId: number; at: Date; action: 'start' | 'end' },
) {
  const rec = await trx
    .selectFrom('punch_record')
    .selectAll()
    .where('employee_id', '=', p.empId)
    .where('actual_punch_out', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!rec || rec.hotel_id !== p.hotelId) throw new AppError('NOT_FOUND', 'Open time record not found');
  const segs = ((rec.break_segments as BreakSegment[] | null) ?? []).slice();
  const last = segs[segs.length - 1];
  const onBreak = !!last && last.end == null;
  if (p.action === 'start') {
    if (onBreak) throw new AppError('CONFLICT', 'Break already started', { since: last!.start });
    segs.push({ start: p.at.toISOString(), end: null });
  } else {
    if (!onBreak) throw new AppError('CONFLICT', 'No break is running');
    last!.end = p.at.toISOString();
  }
  await trx
    .updateTable('punch_record')
    .set({ break_segments: JSON.stringify(segs), updated_at: p.at })
    .where('id', '=', rec.id)
    .execute();
  const user = await trx
    .selectFrom('employee')
    .select('user_id')
    .where('employee_id', '=', p.empId)
    .executeTakeFirstOrThrow();
  await audit(trx, actorFor(user.user_id), {
    action: p.action === 'start' ? 'break_start' : 'break_end',
    entityType: 'punch_record',
    entityId: rec.id,
    hotelId: p.hotelId,
    companyId: p.companyId,
    new: { at: p.at.toISOString() },
  });
  return {
    recordId: rec.id,
    onBreak: p.action === 'start',
    breakMinutes: segmentMinutes(segs, p.at),
    segments: segs,
  };
}
