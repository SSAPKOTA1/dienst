import { absenceLimitIssues, type BlackoutRule } from '@dienst/rules';
import type { DbOrTrx } from '../db';

/** Blackout / concurrent-absence violations for a vacation range (SPEC backlog M10). All of them need a reason from planners and block employee requests. */
export async function leaveLimitIssues(
  db: DbOrTrx,
  employeeId: number,
  from: string,
  to: string,
  days: string[],
  excludeTimeOffId?: number,
) {
  if (!days.length) return [];
  const e = await db
    .selectFrom('employee')
    .select(['primary_hotel_id', 'primary_department_id'])
    .where('employee_id', '=', employeeId)
    .executeTakeFirstOrThrow();
  const bl = await db
    .selectFrom('absence_blackout')
    .selectAll()
    .where('hotel_id', '=', e.primary_hotel_id)
    .where('to_date', '>=', from)
    .where('from_date', '<=', to)
    .execute();
  const dept = await db
    .selectFrom('department')
    .select('max_concurrent_absent')
    .where('id', '=', e.primary_department_id)
    .executeTakeFirstOrThrow();
  const needCount = bl.some((b) => b.max_concurrent_absent != null) || dept.max_concurrent_absent != null;
  const absentOthers: Record<string, number> = {};
  if (needCount) {
    let qb = db
      .selectFrom('time_off as t')
      .innerJoin('employee as o', 'o.employee_id', 't.employee_id')
      .select(['t.start_date', 't.end_date', 't.employee_id'])
      .where('o.primary_department_id', '=', e.primary_department_id)
      .where('t.employee_id', '<>', employeeId)
      .where('t.status', '=', 'approved')
      .where('t.type', '<>', 'off_day')
      .where('t.end_date', '>=', from)
      .where('t.start_date', '<=', to);
    if (excludeTimeOffId) qb = qb.where('t.id', '<>', excludeTimeOffId);
    for (const o of await qb.execute())
      for (const d of days)
        if (o.start_date <= d && o.end_date >= d) absentOthers[d] = (absentOthers[d] ?? 0) + 1;
  }
  const blackouts: BlackoutRule[] = bl.map((b) => ({
    id: b.id,
    departmentId: b.department_id,
    from: b.from_date,
    to: b.to_date,
    reason: b.reason,
    maxConcurrentAbsent: b.max_concurrent_absent,
  }));
  return absenceLimitIssues({
    days,
    departmentId: e.primary_department_id,
    blackouts,
    absentOthers,
    departmentCap: dept.max_concurrent_absent,
  });
}
