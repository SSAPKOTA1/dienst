import { sql } from 'kysely';
import { addDays } from '@dienst/rules';
import type { Db } from '../db';
import { SYSTEM_ACTOR } from '../lib/audit';
import { localDate } from '../lib/time';
import { deactivateEmployee } from './offboarding';

const adminUsersOf = async (db: Db, companyId: number): Promise<number[]> =>
  (
    await db
      .selectFrom('admin_company as ac')
      .innerJoin('admin as a', 'a.admin_id', 'ac.admin_id')
      .select('a.user_id')
      .where('ac.company_id', '=', companyId)
      .where('a.revoked_at', 'is', null)
      .execute()
  ).map((x) => x.user_id);

/** One reminder per (kind, subject, threshold): the payload carries a key and an existing notification suppresses a repeat. */
async function remind(
  db: Db,
  userIds: number[],
  kind: string,
  key: string,
  payload: Record<string, unknown>,
) {
  let sent = 0;
  for (const uid of userIds) {
    const dup = await db
      .selectFrom('notification')
      .select('id')
      .where('user_id', '=', uid)
      .where('kind', '=', kind)
      .where(sql<boolean>`payload->>'key' = ${key}`)
      .executeTakeFirst();
    if (dup) continue;
    await db
      .insertInto('notification')
      .values({ user_id: uid, kind, payload: JSON.stringify({ ...payload, key }) })
      .execute();
    sent++;
  }
  return sent;
}

/** Qualification and document expiry (30 and 7 days before), contract and probation end alerts (30 and 14 days). */
export async function runReminders(db: Db, now: Date): Promise<number> {
  const today = localDate(now, 'Europe/Berlin');
  let sent = 0;
  for (const d of [30, 7]) {
    const day = addDays(today, d);
    const quals = await db
      .selectFrom('employee_qualification as eq')
      .innerJoin('employee as e', 'e.employee_id', 'eq.employee_id')
      .innerJoin('qualification as q', 'q.id', 'eq.qualification_id')
      .select([
        'eq.employee_id',
        'eq.qualification_id',
        'eq.valid_until',
        'q.name',
        'e.company_id',
        'e.display_name',
      ])
      .where('e.status', '=', 'active')
      .where('eq.valid_until', '<=', day)
      .where('eq.valid_until', '>=', today)
      .execute();
    for (const q of quals) {
      const left = Math.round((Date.parse(q.valid_until!) - Date.parse(today)) / 86400000);
      const threshold = left <= 7 ? 7 : 30;
      if (threshold !== d) continue;
      sent += await remind(
        db,
        await adminUsersOf(db, q.company_id),
        'qualification_expiring',
        `q${q.employee_id}:${q.qualification_id}:${q.valid_until}:${threshold}`,
        {
          employeeId: q.employee_id,
          name: q.display_name,
          qualification: q.name,
          validUntil: q.valid_until,
          days: left,
        },
      );
    }
    const docs = await db
      .selectFrom('employee_document as d')
      .innerJoin('employee as e', 'e.employee_id', 'd.employee_id')
      .select(['d.id', 'd.title', 'd.valid_until', 'd.employee_id', 'e.company_id', 'e.display_name'])
      .where('e.status', '=', 'active')
      .where('d.valid_until', '<=', day)
      .where('d.valid_until', '>=', today)
      .execute();
    for (const x of docs) {
      const left = Math.round((Date.parse(x.valid_until!) - Date.parse(today)) / 86400000);
      const threshold = left <= 7 ? 7 : 30;
      if (threshold !== d) continue;
      sent += await remind(
        db,
        await adminUsersOf(db, x.company_id),
        'document_expiring',
        `d${x.id}:${threshold}`,
        {
          employeeId: x.employee_id,
          name: x.display_name,
          title: x.title,
          validUntil: x.valid_until,
          days: left,
        },
      );
    }
  }
  for (const d of [30, 14]) {
    const day = addDays(today, d);
    const ending = await db
      .selectFrom('employee')
      .select(['employee_id', 'company_id', 'display_name', 'contract_end_date'])
      .where('status', '=', 'active')
      .where('contract_end_date', '<=', day)
      .where('contract_end_date', '>=', today)
      .execute();
    for (const e of ending) {
      const left = Math.round((Date.parse(e.contract_end_date!) - Date.parse(today)) / 86400000);
      const threshold = left <= 14 ? 14 : 30;
      if (threshold !== d) continue;
      sent += await remind(
        db,
        await adminUsersOf(db, e.company_id),
        'contract_ending',
        `c${e.employee_id}:${e.contract_end_date}:${threshold}`,
        { employeeId: e.employee_id, name: e.display_name, lastDay: e.contract_end_date, days: left },
      );
    }
  }
  // public API keys: the creator and the company admins hear about it 14 and 3 days before a key stops working
  for (const d of [14, 3]) {
    const until = new Date(now.getTime() + d * 86400e3);
    const keys = await db
      .selectFrom('api_key')
      .select(['id', 'company_id', 'name', 'expires_at', 'created_by_user_id'])
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now)
      .where('expires_at', '<=', until)
      .execute();
    for (const k of keys) {
      const left = Math.ceil((k.expires_at.getTime() - now.getTime()) / 86400e3);
      if ((left <= 3 ? 3 : 14) !== d) continue;
      const users = new Set([
        ...(await adminUsersOf(db, k.company_id)),
        ...(k.created_by_user_id ? [k.created_by_user_id] : []),
      ]);
      sent += await remind(db, [...users], 'api_key_expiring', `k${k.id}:${d}`, {
        keyId: k.id,
        name: k.name,
        expiresAt: k.expires_at.toISOString(),
        days: left,
      });
    }
  }
  return sent;
}

/** After the last working day the PIN and the login stop working (SPEC backlog: offboarding). */
export async function runOffboarding(db: Db, now: Date): Promise<number> {
  const today = localDate(now, 'Europe/Berlin');
  const rows = await db
    .selectFrom('employee')
    .select('employee_id')
    .where('status', '=', 'active')
    .where('contract_end_date', '<', today)
    .execute();
  for (const r of rows)
    await db.transaction().execute((trx) => deactivateEmployee(trx, r.employee_id, now, SYSTEM_ACTOR));
  return rows.length;
}
