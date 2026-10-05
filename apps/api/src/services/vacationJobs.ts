import type { Db, DbOrTrx } from '../db';
import { audit, SYSTEM_ACTOR, type Actor } from '../lib/audit';
import { remainingDays, ensureAllowance } from './vacation';

type NoticeKind = 'initial' | 'reminder' | 'final';

/**
 * Year-end carryover (BUrlG § 7 Abs. 3): the unused days of `year` move to `year + 1`. Idempotent: it sets the carried
 * values instead of adding to them. Statutory days are carried first. The carryover expires on 31 March of the next year.
 */
export async function carryOver(
  db: DbOrTrx,
  year: number,
  scope: { companyIds?: number[]; hotelIds?: number[] } = {},
  actor: Actor = SYSTEM_ACTOR,
) {
  let q = db
    .selectFrom('employee as e')
    .select(['e.employee_id', 'e.company_id', 'e.primary_hotel_id'])
    .where('e.status', '=', 'active');
  if (scope.companyIds) q = q.where('e.company_id', 'in', scope.companyIds.length ? scope.companyIds : [-1]);
  if (scope.hotelIds) q = q.where('e.primary_hotel_id', 'in', scope.hotelIds.length ? scope.hotelIds : [-1]);
  const emps = await q.execute();
  let carried = 0;
  for (const e of emps) {
    const a = await db
      .selectFrom('employee_vacation_allowance')
      .selectAll()
      .where('employee_id', '=', e.employee_id)
      .where('year', '=', year)
      .executeTakeFirst();
    if (!a) continue;
    const rem = Math.max(0, remainingDays(a));
    const next = await ensureAllowance(db, e.employee_id, year + 1);
    const statutory = Math.min(rem, a.statutory_days);
    const contractual = Math.max(0, rem - statutory);
    if (next.carried_statutory_days === statutory && next.carried_contractual_days === contractual) continue;
    await db
      .updateTable('employee_vacation_allowance')
      .set({
        carried_statutory_days: statutory,
        carried_contractual_days: contractual,
        carryover_expires_on: `${year + 1}-03-31`,
        updated_at: new Date(),
      })
      .where('id', '=', next.id)
      .execute();
    carried++;
    await audit(db, actor, {
      action: 'vacation_carried_over',
      entityType: 'employee',
      entityId: e.employee_id,
      hotelId: e.primary_hotel_id,
      companyId: e.company_id,
      new: { fromYear: year, statutory, contractual },
    });
  }
  return { employees: emps.length, carried };
}

/** After 31 March the unused carryover expires, but only for employees who received the initial notice (BAG/EuGH duty). */
export async function forfeitCarryover(db: DbOrTrx, year: number, actor: Actor = SYSTEM_ACTOR) {
  const rows = await db
    .selectFrom('employee_vacation_allowance as a')
    .innerJoin('employee as e', 'e.employee_id', 'a.employee_id')
    .select([
      'a.id',
      'a.employee_id',
      'a.used_days',
      'a.carried_statutory_days',
      'a.carried_contractual_days',
      'e.company_id',
      'e.primary_hotel_id',
    ])
    .where('a.year', '=', year)
    .where((eb) => eb.or([eb('a.carried_statutory_days', '>', 0), eb('a.carried_contractual_days', '>', 0)]))
    .execute();
  let forfeited = 0;
  for (const r of rows) {
    const notice = await db
      .selectFrom('vacation_notice')
      .select('id')
      .where('employee_id', '=', r.employee_id)
      .where('year', '=', year - 1)
      .executeTakeFirst();
    if (!notice) continue; // without a notice the days do not expire
    const carried = r.carried_statutory_days + r.carried_contractual_days;
    const keep = Math.min(carried, r.used_days); // carried days are consumed first
    if (keep >= carried) continue;
    const keepStat = Math.min(keep, r.carried_statutory_days);
    await db
      .updateTable('employee_vacation_allowance')
      .set({
        carried_statutory_days: keepStat,
        carried_contractual_days: keep - keepStat,
        updated_at: new Date(),
      })
      .where('id', '=', r.id)
      .execute();
    forfeited++;
    await audit(db, actor, {
      action: 'vacation_carryover_expired',
      entityType: 'employee',
      entityId: r.employee_id,
      hotelId: r.primary_hotel_id,
      companyId: r.company_id,
      new: { year, forfeitedDays: carried - keep },
    });
  }
  return { forfeited };
}

/** Informs employees with remaining vacation (proof of the duty to inform). Idempotent per employee, year and kind. */
export async function sendNotices(
  db: DbOrTrx,
  year: number,
  kind: NoticeKind,
  scope: { companyIds?: number[]; hotelIds?: number[]; employeeIds?: number[] } = {},
) {
  let q = db
    .selectFrom('employee as e')
    .select(['e.employee_id', 'e.user_id'])
    .where('e.status', '=', 'active');
  if (scope.companyIds) q = q.where('e.company_id', 'in', scope.companyIds.length ? scope.companyIds : [-1]);
  if (scope.hotelIds) q = q.where('e.primary_hotel_id', 'in', scope.hotelIds.length ? scope.hotelIds : [-1]);
  if (scope.employeeIds)
    q = q.where('e.employee_id', 'in', scope.employeeIds.length ? scope.employeeIds : [-1]);
  let sent = 0;
  let skipped = 0;
  for (const e of await q.execute()) {
    const a = await ensureAllowance(db, e.employee_id, year);
    const rem = remainingDays(a);
    const exists = await db
      .selectFrom('vacation_notice')
      .select('id')
      .where('employee_id', '=', e.employee_id)
      .where('year', '=', year)
      .where('kind', '=', kind)
      .executeTakeFirst();
    if (exists || rem <= 0) {
      skipped++;
      continue;
    }
    const n = await db
      .insertInto('vacation_notice')
      .values({ employee_id: e.employee_id, year, kind, remaining_days: rem, channel: 'in_app' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('notification')
      .values({
        user_id: e.user_id,
        employee_id: e.employee_id,
        kind: 'vacation_notice',
        payload: JSON.stringify({ noticeId: n.id, year, kind, remainingDays: rem }),
      })
      .execute();
    sent++;
  }
  return { sent, skipped };
}

/** Date-triggered, idempotent yearly jobs, run once a day by the background timer. */
export async function runVacationJobs(db: Db, now: Date) {
  const y = now.getUTCFullYear();
  const md = now.toISOString().slice(5, 10);
  if (md >= '01-01' && md <= '01-07') await carryOver(db, y - 1);
  if (md === '04-01') await forfeitCarryover(db, y);
  if (md === '10-01') await sendNotices(db, y, 'initial');
  if (md === '11-15') await sendNotices(db, y, 'reminder');
  if (md === '12-01') await sendNotices(db, y, 'final');
}
