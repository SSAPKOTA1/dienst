import { countedDays, timeAccountBalance, addDays } from '@dienst/rules';
import type { DbOrTrx } from '../db';
import { resolveHolidays } from './holidays';

/** SPEC 4.15. Returns null when the employee has no time account (hourly or no target). */
export async function computeTimeAccount(
  db: DbOrTrx,
  employeeId: number,
  today: string,
): Promise<number | null> {
  const emp = await db
    .selectFrom('employee')
    .select(['contract_start_date', 'opening_balance_hours', 'primary_hotel_id'])
    .where('employee_id', '=', employeeId)
    .executeTakeFirst();
  if (!emp) return null;
  const c = await db
    .selectFrom('employee_contract')
    .selectAll()
    .where('employee_id', '=', employeeId)
    .where('valid_from', '<=', today)
    .orderBy('valid_from', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!c || c.working_model !== 'salary') return null;
  const weekly =
    c.target_hours_per_week ??
    (c.target_hours_per_month != null ? (c.target_hours_per_month * 12) / 52 : null);
  if (weekly == null && c.target_hours_per_month == null) return null;
  const monthly = c.target_hours_per_month ?? ((weekly as number) * 52) / 12;
  const daily = c.daily_target_hours ?? (weekly != null ? weekly / c.work_days_per_week : 0);
  const start = emp.contract_start_date;
  const last = addDays(today, -1); // today is exclusive
  if (last < start) return Math.round(emp.opening_balance_hours * 100) / 100;

  const punches = await db
    .selectFrom('punch_record')
    .select((eb) => eb.fn.sum<number>('paid_hours').as('h'))
    .where('employee_id', '=', employeeId)
    .where('approval_status', '=', 'approved')
    .where('shift_date', '>=', start)
    .where('shift_date', '<=', last)
    .executeTakeFirst();
  const approved = Number(punches?.h ?? 0);

  const holidays = new Set((await resolveHolidays(db, emp.primary_hotel_id, start, last)).keys());
  const absences = await db
    .selectFrom('time_off as t')
    .innerJoin('absence_type as a', 'a.code', 't.type')
    .select(['t.start_date', 't.end_date', 'a.credits_hours', 'a.reduces_target'])
    .where('t.employee_id', '=', employeeId)
    .where('t.status', '=', 'approved')
    .where('t.end_date', '>=', start)
    .where('t.start_date', '<=', last)
    .execute();
  let creditDays = 0;
  let unpaidDays = 0;
  const absentDays = new Set<string>();
  for (const a of absences) {
    const from = a.start_date < start ? start : a.start_date;
    const to = a.end_date > last ? last : a.end_date;
    const days = countedDays(from, to, c.working_weekdays, holidays);
    days.forEach((d) => absentDays.add(d));
    if (a.credits_hours) creditDays += days.length;
    if (a.reduces_target) unpaidDays += days.length;
  }
  // public holidays on working weekdays without an absence or a punch are credited (salary workers)
  const punchDays = new Set(
    (
      await db
        .selectFrom('punch_record')
        .select('shift_date')
        .where('employee_id', '=', employeeId)
        .where('shift_date', '>=', start)
        .where('shift_date', '<=', last)
        .execute()
    ).map((r) => r.shift_date),
  );
  for (const h of holidays) {
    if (h >= start && h <= last && !absentDays.has(h) && !punchDays.has(h)) {
      if (countedDays(h, h, c.working_weekdays, new Set()).length) creditDays += 1;
    }
  }
  return timeAccountBalance({
    opening: emp.opening_balance_hours,
    monthlyTarget: monthly,
    startIso: start,
    asOfIso: today,
    approvedPaidHours: approved,
    creditHours: creditDays * daily,
    unpaidDays,
    dailyTarget: daily,
  });
}
