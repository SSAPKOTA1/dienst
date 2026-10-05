import { sql } from 'kysely';
import type { Db, DbOrTrx, Trx } from '../db';
import { audit, SYSTEM_ACTOR, type Actor } from '../lib/audit';
import { AppError } from '../lib/errors';
import { localDate } from '../lib/time';
import { addDays } from '@dienst/rules';

/** Audit actions that record who looked at personal data (listed in the access log). */
export const ACCESS_ACTIONS = [
  'personal_data_viewed',
  'personal_data_exported',
  'document_downloaded',
  'employee_anonymised',
] as const;

/** Entries about the same actor and person inside this window count as one view. */
const VIEW_DEDUP_MINUTES = 10;

/** Records that an actor looked at a person's data (at most one entry per actor, person and 10 minutes). */
export async function logPersonalDataView(
  db: Db,
  actor: Actor,
  employee: { employee_id: number; company_id: number; primary_hotel_id: number },
  windowMinutes = VIEW_DEDUP_MINUTES,
): Promise<void> {
  if (!actor.userId) return;
  const recent = await db
    .selectFrom('audit_log')
    .select('id')
    .where('entity_type', '=', 'employee')
    .where('entity_id', '=', employee.employee_id)
    .where('action', '=', 'personal_data_viewed')
    .where('actor_id', '=', actor.userId)
    .where(sql<boolean>`created_at > now() - make_interval(mins => ${windowMinutes})`)
    .limit(1)
    .executeTakeFirst();
  if (recent) return;
  await audit(db, actor, {
    action: 'personal_data_viewed',
    entityType: 'employee',
    entityId: employee.employee_id,
    companyId: employee.company_id,
    hotelId: employee.primary_hotel_id,
  });
}

/** Everything stored about one person (Art. 15 and 20 GDPR). Document files are listed, not included. */
export async function collectEmployeeData(db: DbOrTrx, employeeId: number) {
  const e = await db
    .selectFrom('employee')
    .select([
      'employee_id',
      'personnel_number',
      'first_name',
      'last_name',
      'date_of_birth',
      'preferred_language',
      'contact_email',
      'phone',
      'status',
      'contract_start_date',
      'contract_end_date',
      'opening_balance_hours',
      'is_floater',
      'work_time_protection',
      'created_at',
    ])
    .where('employee_id', '=', employeeId)
    .executeTakeFirstOrThrow();
  const u = await db
    .selectFrom('employee as e')
    .innerJoin('user_account as u', 'u.id', 'e.user_id')
    .select(['u.email', 'u.username', 'u.status', 'u.last_login_at', 'u.created_at'])
    .where('e.employee_id', '=', employeeId)
    .executeTakeFirst();
  const byEmp = <T extends keyof import('../db').DB>(table: T) =>
    // every table below has an employee_id column; the selectAll typing needs the cast
    (db.selectFrom(table as never) as unknown as import('kysely').SelectQueryBuilder<never, never, object>)
      .selectAll()
      .where(sql<boolean>`employee_id = ${employeeId}`);
  const [contracts, schedule, punches, timeOff, corrections, variations, notes, shiftWishes, leaveWishes] =
    await Promise.all([
      byEmp('employee_contract')
        .orderBy(sql`valid_from`)
        .execute(),
      byEmp('schedule')
        .orderBy(sql`planned_start`)
        .execute(),
      byEmp('punch_record')
        .orderBy(sql`id`)
        .execute(),
      byEmp('time_off')
        .orderBy(sql`start_date`)
        .execute(),
      byEmp('time_correction_request')
        .orderBy(sql`id`)
        .execute(),
      byEmp('time_variation')
        .orderBy(sql`id`)
        .execute(),
      byEmp('notification')
        .orderBy(sql`id`)
        .execute(),
      byEmp('employee_shift_wish').execute(),
      byEmp('employee_leave_wish').execute(),
    ]);
  const [availability, qualifications, allowances, ledger, vacationNotices, questions] = await Promise.all([
    byEmp('employee_availability').execute(),
    byEmp('employee_qualification').execute(),
    byEmp('employee_vacation_allowance').execute(),
    byEmp('arbeitszeitkonto_entry')
      .orderBy(sql`id`)
      .execute(),
    byEmp('vacation_notice').execute(),
    byEmp('management_question').execute(),
  ]);
  const documents = await db
    .selectFrom('employee_document')
    .select(['id', 'doc_type', 'title', 'file_name', 'mime', 'size_bytes', 'valid_until', 'created_at'])
    .where('employee_id', '=', employeeId)
    .execute();
  return {
    profile: e,
    account: u ?? null,
    contracts,
    schedule,
    punchRecords: punches,
    absences: timeOff,
    timeCorrections: corrections,
    timeVariations: variations,
    notifications: notes,
    shiftWishes,
    leaveWishes,
    availability,
    qualifications,
    vacationAllowances: allowances,
    timeAccountEntries: ledger,
    vacationNotices,
    questionsToManagement: questions,
    documents,
  };
}

/** The legal minimum for time records (ArbZG §16): a company setting below it is raised to it. */
export const MIN_RETENTION_MONTHS = 24;

/** First day on which the person may be anonymised: the day after contract end plus the retention months. */
export function eligibleFrom(contractEnd: string, retentionMonths: number): string {
  const d = new Date(`${contractEnd}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + Math.max(MIN_RETENTION_MONTHS, retentionMonths));
  return addDays(d.toISOString().slice(0, 10), 1);
}

export interface AnonymiseResult {
  accountAnonymised: boolean;
}

/**
 * Removes the identity of a person but keeps the statutory records (hours worked, absences, schedule) so that
 * working-time records stay complete for the retention period without naming anyone.
 * Refuses while the retention period runs (time records must be kept at least two years, ArbZG §16).
 */
export async function anonymiseEmployee(
  trx: Trx,
  employeeId: number,
  now: Date,
  actor: Actor,
  reason: string | null,
): Promise<AnonymiseResult> {
  const e = await trx
    .selectFrom('employee as e')
    .innerJoin('company as c', 'c.id', 'e.company_id')
    .select([
      'e.employee_id',
      'e.user_id',
      'e.company_id',
      'e.primary_hotel_id',
      'e.status',
      'e.contract_end_date',
      'e.anonymised_at',
      'c.retention_months',
    ])
    .where('e.employee_id', '=', employeeId)
    .forUpdate()
    .executeTakeFirst();
  if (!e) throw new AppError('NOT_FOUND', 'Employee not found');
  if (e.anonymised_at) throw new AppError('CONFLICT', 'Already anonymised');
  if (e.status === 'active' || !e.contract_end_date)
    throw new AppError('CONFLICT', 'Only employees who have left can be anonymised', {
      code: 'STILL_EMPLOYED',
    });
  const from = eligibleFrom(e.contract_end_date, e.retention_months);
  const today = localDate(now, 'Europe/Berlin');
  if (today < from)
    throw new AppError('CONFLICT', 'The retention period has not ended', {
      code: 'RETENTION_ACTIVE',
      eligibleFrom: from,
    });

  await trx
    .updateTable('employee')
    .set({
      first_name: 'Gelöscht',
      last_name: `#${e.employee_id}`,
      date_of_birth: sql`make_date(extract(year from date_of_birth)::int, 1, 1)`,
      contact_email: null,
      phone: null,
      badge_hash: null,
      pin_hash: 'anonymised',
      pin_locked_until: new Date('2999-01-01T00:00:00Z'),
      status: 'inactive',
      anonymised_at: now,
      updated_at: now,
    })
    .where('employee_id', '=', e.employee_id)
    .execute();

  for (const table of [
    'employee_document',
    'notification',
    'employee_availability',
    'employee_shift_wish',
    'employee_leave_wish',
    'announcement_ack',
    'management_question',
    'calendar_feed',
    'vacation_notice',
  ] as const)
    await sql`delete from ${sql.table(table)} where employee_id = ${e.employee_id}`.execute(trx);

  // the login account goes too, unless the same account still belongs to another person record or a staff role
  const shared = await sql<{ n: number }>`
    select (
      (select count(*) from employee where user_id = ${e.user_id} and employee_id <> ${e.employee_id} and anonymised_at is null)
      + (select count(*) from admin where user_id = ${e.user_id})
      + (select count(*) from manager where user_id = ${e.user_id})
      + (select count(*) from super_admin where user_id = ${e.user_id})
    )::int as n`.execute(trx);
  const accountAnonymised = (shared.rows[0]?.n ?? 0) === 0;
  if (accountAnonymised) {
    await trx
      .updateTable('user_account')
      .set({
        email: null,
        username: `deleted-${e.user_id}`,
        password_hash: null,
        totp_secret_enc: null,
        totp_enabled: false,
        status: 'disabled',
        invitation_token_hash: null,
        invitation_expires_at: null,
        updated_at: now,
      })
      .where('id', '=', e.user_id)
      .execute();
    await trx.deleteFrom('refresh_token').where('user_id', '=', e.user_id).execute();
    await trx.deleteFrom('sso_identity').where('user_id', '=', e.user_id).execute();
    await trx
      .updateTable('feed_post')
      .set({ author_name: 'Gelöscht' })
      .where('author_user_id', '=', e.user_id)
      .execute();
    await trx
      .updateTable('feed_comment')
      .set({ author_name: 'Gelöscht' })
      .where('author_user_id', '=', e.user_id)
      .execute();
  }

  await audit(trx, actor, {
    action: 'employee_anonymised',
    entityType: 'employee',
    entityId: e.employee_id,
    companyId: e.company_id,
    hotelId: e.primary_hotel_id,
    new: { accountAnonymised },
    reason,
  });
  return { accountAnonymised };
}

/** Daily: anonymises everybody whose contract ended more than `retention_months` ago. Returns how many. */
export async function runRetention(db: Db, now: Date): Promise<number> {
  const today = localDate(now, 'Europe/Berlin');
  const rows = await db
    .selectFrom('employee as e')
    .innerJoin('company as c', 'c.id', 'e.company_id')
    .select(['e.employee_id', 'e.contract_end_date', 'c.retention_months'])
    .where('e.anonymised_at', 'is', null)
    .where('e.status', '!=', 'active')
    .where('e.contract_end_date', 'is not', null)
    // cheap pre-filter: nobody leaves less than the legal minimum of 24 months ago
    .where('e.contract_end_date', '<', addDays(today, -730))
    .execute();
  let n = 0;
  for (const r of rows) {
    if (today < eligibleFrom(r.contract_end_date!, r.retention_months)) continue;
    await db
      .transaction()
      .execute((trx) => anonymiseEmployee(trx, r.employee_id, now, SYSTEM_ACTOR, 'retention'));
    n += 1;
  }
  return n;
}
