import { proratedVacationDays } from '@dienst/rules';
import type { DbOrTrx } from '../db';

export interface ContractRow {
  vacation_days_per_year: number;
  work_days_per_week: number;
  valid_from: string;
}

export async function ensureAllowance(
  db: DbOrTrx,
  employeeId: number,
  year: number,
  opts: { allocated?: number; used?: number } = {},
) {
  const existing = await db
    .selectFrom('employee_vacation_allowance')
    .selectAll()
    .where('employee_id', '=', employeeId)
    .where('year', '=', year)
    .executeTakeFirst();
  if (existing) return existing;
  const emp = await db
    .selectFrom('employee')
    .select('contract_start_date')
    .where('employee_id', '=', employeeId)
    .executeTakeFirstOrThrow();
  const c = await db
    .selectFrom('employee_contract')
    .select(['vacation_days_per_year', 'work_days_per_week'])
    .where('employee_id', '=', employeeId)
    .where('valid_from', '<=', `${year}-12-31`)
    .orderBy('valid_from', 'desc')
    .limit(1)
    .executeTakeFirst();
  const total = c?.vacation_days_per_year ?? 0;
  const wd = c?.work_days_per_week ?? 5;
  const statutory = Math.min(total, 4 * wd);
  const allocated = opts.allocated ?? proratedVacationDays(total, emp.contract_start_date, year);
  const inserted = await db
    .insertInto('employee_vacation_allowance')
    .values({
      employee_id: employeeId,
      year,
      vacation_days_total: total,
      statutory_days: statutory,
      contractual_days: total - statutory,
      allocated_days: allocated,
      used_days: opts.used ?? 0,
    })
    // two requests may create the row at the same moment (first read of a year): the loser reads the winner's row
    .onConflict((oc) => oc.columns(['employee_id', 'year']).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return inserted;
  return db
    .selectFrom('employee_vacation_allowance')
    .selectAll()
    .where('employee_id', '=', employeeId)
    .where('year', '=', year)
    .executeTakeFirstOrThrow();
}

export const remainingDays = (a: {
  allocated_days: number;
  used_days: number;
  carried_statutory_days: number;
  carried_contractual_days: number;
}) => a.allocated_days + a.carried_statutory_days + a.carried_contractual_days - a.used_days;

export async function vacationSummary(db: DbOrTrx, employeeId: number, year: number) {
  const a = await ensureAllowance(db, employeeId, year);
  return {
    year,
    allocated: a.allocated_days + a.carried_statutory_days + a.carried_contractual_days,
    used: a.used_days,
    remaining: remainingDays(a),
  };
}
