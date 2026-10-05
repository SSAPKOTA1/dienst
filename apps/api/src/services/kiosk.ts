import { paidHours, requiredBreakMinutes, variationMinutes, withinGrace } from '@dienst/rules';
import { BREAK_OPTIONS } from '@dienst/shared';
import type { Db, DbOrTrx, Trx } from '../db';
import { AppError } from '../lib/errors';
import { verifySecret } from '../lib/security';
import { localDate } from '../lib/time';

export interface Device {
  id: number;
  hotelId: number;
  name: string;
}

export const PIN_MAX_FAILS = 5;
export const PIN_LOCK_MS = 15 * 60e3;

export interface EmployeeRow {
  employee_id: number;
  user_id: number;
  company_id: number;
  primary_hotel_id: number;
  pin_hash: string;
  pin_failed_count: number;
  pin_locked_until: Date | null;
  status: string;
  display_name: string | null;
}

/** SPEC 4.5 step 7: 5 wrong PINs lock for 15 minutes. The failure counter is committed even though the request fails. */
export async function verifyPin(db: Db, empId: number, pin: string, now: Date): Promise<EmployeeRow> {
  const e = (await db
    .selectFrom('employee')
    .selectAll()
    .where('employee_id', '=', empId)
    .executeTakeFirst()) as unknown as EmployeeRow | undefined;
  if (!e || e.status !== 'active') throw new AppError('NOT_FOUND', 'Employee not found');
  if (e.pin_locked_until && e.pin_locked_until > now)
    throw new AppError('PIN_LOCKED', 'PIN is locked', { lockedUntil: e.pin_locked_until.toISOString() });
  let count = e.pin_failed_count;
  if (e.pin_locked_until && e.pin_locked_until <= now) count = 0; // lock expired
  if (await verifySecret(e.pin_hash, pin)) {
    if (count !== 0 || e.pin_locked_until)
      await db
        .updateTable('employee')
        .set({ pin_failed_count: 0, pin_locked_until: null })
        .where('employee_id', '=', empId)
        .execute();
    return e;
  }
  count += 1;
  const locked = count >= PIN_MAX_FAILS;
  await db
    .updateTable('employee')
    .set({ pin_failed_count: count, pin_locked_until: locked ? new Date(now.getTime() + PIN_LOCK_MS) : null })
    .where('employee_id', '=', empId)
    .execute();
  if (locked)
    throw new AppError('PIN_LOCKED', 'PIN is locked', {
      lockedUntil: new Date(now.getTime() + PIN_LOCK_MS).toISOString(),
    });
  throw new AppError('PIN_INVALID', 'Wrong PIN', { remainingAttempts: PIN_MAX_FAILS - count });
}

export interface MatchedEntry {
  id: number;
  planned_start: Date;
  planned_end: Date;
  planned_break_minutes: number;
}

/** SPEC 4.5 step 1: published entry at the kiosk hotel within +-3 h that has no time record yet; closest start wins. */
export async function matchSchedule(
  db: DbOrTrx,
  hotelId: number,
  employeeId: number,
  now: Date,
): Promise<MatchedEntry | null> {
  const lo = new Date(now.getTime() - 3 * 3600e3);
  const hi = new Date(now.getTime() + 3 * 3600e3);
  const rows = await db
    .selectFrom('schedule as s')
    .select(['s.id', 's.planned_start', 's.planned_end', 's.planned_break_minutes'])
    .where('s.hotel_id', '=', hotelId)
    .where('s.employee_id', '=', employeeId)
    .where('s.status', '=', 'published')
    .where('s.planned_start', '<=', hi)
    .where('s.planned_end', '>=', lo)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('punch_record as p')
            .select('p.id')
            .whereRef('p.schedule_id', '=', 's.id')
            .where('p.approval_status', '<>', 'rejected'),
        ),
      ),
    )
    .execute();
  rows.sort(
    (a, b) =>
      Math.abs(a.planned_start.getTime() - now.getTime()) -
      Math.abs(b.planned_start.getTime() - now.getTime()),
  );
  return (rows[0] as MatchedEntry | undefined) ?? null;
}

export const graceOf = async (db: DbOrTrx, companyId: number): Promise<number> =>
  (
    await db
      .selectFrom('company')
      .select('grace_period_minutes')
      .where('id', '=', companyId)
      .executeTakeFirstOrThrow()
  ).grace_period_minutes;

export async function hotelTz(db: DbOrTrx, hotelId: number): Promise<string> {
  return (await db.selectFrom('hotel').select('timezone').where('id', '=', hotelId).executeTakeFirstOrThrow())
    .timezone;
}

/** Clock-out computation shared by the kiosk confirmation, the auto-checkout job and manager close-outs. */
export function computeClose(
  rec: { paid_start: Date | null; actual_punch_in: Date; planned_end: Date | null; is_unplanned: boolean },
  outAt: Date,
  grace: number,
) {
  const paidStart = rec.paid_start ?? rec.actual_punch_in;
  let paidEnd = outAt;
  let endVariation: number | null = null;
  if (rec.planned_end && !rec.is_unplanned) {
    endVariation = variationMinutes(outAt.toISOString(), rec.planned_end.toISOString());
    if (withinGrace(endVariation, grace)) paidEnd = rec.planned_end;
  }
  const gross = Math.max(0, Math.floor((paidEnd.getTime() - paidStart.getTime()) / 60000));
  return {
    paidStart,
    paidEnd,
    endVariation,
    outsideGrace: endVariation != null && !withinGrace(endVariation, grace),
    grossMinutes: gross,
    requiredBreak: requiredBreakMinutes(gross),
  };
}

export const breakOptions = (required: number): number[] =>
  [...new Set([...BREAK_OPTIONS, required])].sort((a, b) => a - b);

export const paidFor = (paidStart: Date, paidEnd: Date, breakMin: number): number =>
  Math.max(
    0,
    paidHours(Math.max(0, Math.floor((paidEnd.getTime() - paidStart.getTime()) / 60000)), breakMin),
  );

export async function hotelManagerUsers(db: DbOrTrx, hotelId: number): Promise<number[]> {
  const rows = await db
    .selectFrom('manager_hotel as mh')
    .innerJoin('manager as m', 'm.manager_id', 'mh.manager_id')
    .select('m.user_id')
    .where('mh.hotel_id', '=', hotelId)
    .execute();
  return rows.map((r) => r.user_id);
}

export const todayOf = async (db: DbOrTrx, hotelId: number, now: Date) =>
  localDate(now, await hotelTz(db, hotelId));
export type { Trx };
