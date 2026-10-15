import { sql } from 'kysely';
import type { Db, DbOrTrx } from '../db';

/** Kinds shown in the notification bar of admins and super admins (`notification.kind`, 30 characters at most). */
export const ADMIN_ALERT_KINDS = [
  'late_checkin',
  'missed_checkin',
  'missed_checkout',
  'new_shift_wish',
  'new_leave_wish',
  'new_leave_request',
] as const;
export type AdminAlertKind = (typeof ADMIN_ALERT_KINDS)[number];

/**
 * Who gets an alert for a hotel: every super admin, and the admins of the hotel's company or assigned to the hotel.
 * Managers are not part of the bar (they have the inbox under Anträge).
 */
export async function adminAlertRecipients(db: DbOrTrx, hotelId: number): Promise<number[]> {
  const sa = await db.selectFrom('super_admin').select('user_id').where('revoked_at', 'is', null).execute();
  const byCompany = await db
    .selectFrom('admin_company as ac')
    .innerJoin('admin as a', 'a.admin_id', 'ac.admin_id')
    .innerJoin('hotel as h', 'h.company_id', 'ac.company_id')
    .select('a.user_id')
    .where('h.id', '=', hotelId)
    .where('a.revoked_at', 'is', null)
    .execute();
  const byHotel = await db
    .selectFrom('admin_hotel as ah')
    .innerJoin('admin as a', 'a.admin_id', 'ah.admin_id')
    .select('a.user_id')
    .where('ah.hotel_id', '=', hotelId)
    .where('a.revoked_at', 'is', null)
    .execute();
  return [...new Set([...sa, ...byCompany, ...byHotel].map((x) => x.user_id))];
}

/**
 * One alert per (kind, key) and recipient: an existing notification with the same key, read or not, suppresses a
 * repeat, so the minute job can run over the same record again and again. Returns how many alerts were created.
 */
export async function notifyAdmins(
  db: DbOrTrx,
  hotelId: number,
  kind: AdminAlertKind,
  key: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const users = await adminAlertRecipients(db, hotelId);
  if (!users.length) return 0;
  const seen = await db
    .selectFrom('notification')
    .select('user_id')
    .where('user_id', 'in', users)
    .where('kind', '=', kind)
    .where(sql<boolean>`payload->>'key' = ${key}`)
    .execute();
  const have = new Set(seen.map((s) => s.user_id));
  const todo = users.filter((u) => !have.has(u));
  for (const uid of todo)
    await db
      .insertInto('notification')
      .values({
        user_id: uid,
        hotel_id: hotelId,
        kind,
        payload: JSON.stringify({ ...payload, key, hotelId }),
      })
      .execute();
  return todo.length;
}

const LOOKBACK_MS = 24 * 3600e3;

/**
 * Attendance alerts for the notification bar, run every minute by the job scheduler. Thresholds are per company
 * (`alert_*_minutes`). The look-back keeps a restart or an old import from flooding the bar with history.
 *  - late check-in: clocked in more than N minutes after the planned start
 *  - missed check-in: no punch N minutes after the planned start (skipped when the person is on approved leave or is
 *    already clocked in on an overlapping record)
 *  - missed check-out: still clocked in N minutes after the planned end
 */
export async function runAdminAlerts(db: Db, now: Date): Promise<number> {
  const since = new Date(now.getTime() - LOOKBACK_MS);
  let sent = 0;

  const late = await db
    .selectFrom('punch_record as p')
    .innerJoin('hotel as h', 'h.id', 'p.hotel_id')
    .innerJoin('company as c', 'c.id', 'h.company_id')
    .select([
      'p.id',
      'p.hotel_id',
      'p.employee_id',
      'p.shift_date',
      'p.planned_start',
      'p.actual_punch_in',
      'c.alert_late_checkin_minutes as threshold',
    ])
    .where('h.is_active', '=', true)
    .where('p.schedule_id', 'is not', null)
    .where('p.planned_start', 'is not', null)
    .where('p.source', 'in', ['kiosk', 'kiosk_offline', 'web'])
    .where('p.actual_punch_in', '>', since)
    .where(
      sql<boolean>`p.actual_punch_in > p.planned_start + c.alert_late_checkin_minutes * interval '1 minute'`,
    )
    .execute();
  for (const r of late) {
    const minutes = Math.round((r.actual_punch_in.getTime() - r.planned_start!.getTime()) / 60e3);
    sent += await notifyAdmins(db, r.hotel_id, 'late_checkin', `late${r.id}`, {
      punchRecordId: r.id,
      employeeId: r.employee_id,
      date: r.shift_date,
      plannedStart: r.planned_start!.toISOString(),
      minutes,
    });
  }

  const missedIn = await db
    .selectFrom('schedule as s')
    .innerJoin('employee as e', 'e.employee_id', 's.employee_id')
    .innerJoin('hotel as h', 'h.id', 's.hotel_id')
    .innerJoin('company as c', 'c.id', 'h.company_id')
    .select(['s.id', 's.hotel_id', 's.employee_id', 's.shift_date', 's.planned_start'])
    .where('h.is_active', '=', true)
    .where('e.status', '=', 'active')
    .where('s.status', '=', 'published')
    .where('s.planned_start', '>', since)
    .where(sql<boolean>`s.planned_start + c.alert_missed_checkin_minutes * interval '1 minute' <= ${now}`)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('punch_record as p')
            .select('p.id')
            .whereRef('p.employee_id', '=', 's.employee_id')
            .where(
              sql<boolean>`(p.schedule_id = s.id or (p.actual_punch_in < s.planned_end and (p.actual_punch_out is null or p.actual_punch_out > s.planned_start)))`,
            ),
        ),
      ),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('time_off as t')
            .select('t.id')
            .whereRef('t.employee_id', '=', 's.employee_id')
            .where('t.status', '=', 'approved')
            .whereRef('t.start_date', '<=', 's.shift_date')
            .whereRef('t.end_date', '>=', 's.shift_date'),
        ),
      ),
    )
    .execute();
  for (const r of missedIn) {
    sent += await notifyAdmins(db, r.hotel_id, 'missed_checkin', `nocheckin${r.id}`, {
      scheduleId: r.id,
      employeeId: r.employee_id,
      date: r.shift_date,
      plannedStart: r.planned_start.toISOString(),
    });
  }

  const missedOut = await db
    .selectFrom('punch_record as p')
    .innerJoin('hotel as h', 'h.id', 'p.hotel_id')
    .innerJoin('company as c', 'c.id', 'h.company_id')
    .select(['p.id', 'p.hotel_id', 'p.employee_id', 'p.shift_date', 'p.planned_end'])
    .where('h.is_active', '=', true)
    .where('p.actual_punch_out', 'is', null)
    .where('p.planned_end', 'is not', null)
    .where('p.actual_punch_in', '>', since)
    .where(sql<boolean>`p.planned_end + c.alert_missed_checkout_minutes * interval '1 minute' <= ${now}`)
    .execute();
  for (const r of missedOut) {
    sent += await notifyAdmins(db, r.hotel_id, 'missed_checkout', `nocheckout${r.id}`, {
      punchRecordId: r.id,
      employeeId: r.employee_id,
      date: r.shift_date,
      plannedEnd: r.planned_end!.toISOString(),
    });
  }
  return sent;
}
