import { isoWeekday } from '@dienst/rules';
import type { Db } from '../../db';

/** A wish or weekday preference of an employee for one day (never a promise; no reason text). */
export interface DayWish {
  kind: 'work' | 'off';
  source: 'date' | 'leave' | 'weekday';
  shiftName: string | null;
  priority: number | null;
  status: string | null;
}

/** Open and granted wishes plus recurring weekday preferences; the returned lookup gives the wishes of one day. */
export async function loadDayWishes(
  db: Db,
  employeeIds: number[],
  from: string,
  to: string,
): Promise<(employeeId: number, date: string) => DayWish[]> {
  if (!employeeIds.length) return () => [];
  const shiftWishes = await db
    .selectFrom('employee_shift_wish as w')
    .innerJoin('shift as s', 's.id', 'w.shift_id')
    .select(['w.employee_id', 'w.date', 'w.priority', 'w.status', 's.name as shift_name'])
    .where('w.employee_id', 'in', employeeIds)
    .where('w.date', '>=', from)
    .where('w.date', '<=', to)
    .where('w.status', 'in', ['pending', 'granted'])
    .execute();
  const leaveWishes = await db
    .selectFrom('employee_leave_wish')
    .select(['employee_id', 'start_date', 'end_date', 'priority', 'status'])
    .where('employee_id', 'in', employeeIds)
    .where('start_date', '<=', to)
    .where('end_date', '>=', from)
    .where('status', 'in', ['pending', 'granted'])
    .execute();
  const weekdayPrefs = await db
    .selectFrom('employee_weekday_pref as w')
    .leftJoin('shift as s', 's.id', 'w.shift_id')
    .select(['w.employee_id', 'w.weekday', 'w.preference', 's.name as shift_name'])
    .where('w.employee_id', 'in', employeeIds)
    .execute();
  return (employeeId, date) => {
    const dated: DayWish[] = [
      ...shiftWishes
        .filter((w) => w.employee_id === employeeId && w.date === date)
        .map((w) => ({
          kind: 'work' as const,
          source: 'date' as const,
          shiftName: w.shift_name,
          priority: w.priority,
          status: w.status,
        })),
      ...leaveWishes
        .filter((w) => w.employee_id === employeeId && w.start_date <= date && w.end_date >= date)
        .map((w) => ({
          kind: 'off' as const,
          source: 'leave' as const,
          shiftName: null,
          priority: w.priority,
          status: w.status,
        })),
    ];
    // a wish for this very day wins over the recurring weekday preference
    if (dated.length) return dated;
    return weekdayPrefs
      .filter((w) => w.employee_id === employeeId && w.weekday === isoWeekday(date))
      .map((w) => ({
        kind: w.preference === 'good' ? ('work' as const) : ('off' as const),
        source: 'weekday' as const,
        shiftName: w.shift_name,
        priority: null,
        status: null,
      }));
  };
}
