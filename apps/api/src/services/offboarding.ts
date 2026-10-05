import type { Trx } from '../db';
import { audit, type Actor } from '../lib/audit';
import { hashSecret, randomToken } from '../lib/security';

/** Sets the employee inactive, kills the PIN and sessions; the login is disabled unless the person has another role or employment. */
export async function deactivateEmployee(trx: Trx, employeeId: number, now: Date, actor: Actor) {
  const e = await trx
    .selectFrom('employee')
    .select(['employee_id', 'user_id', 'company_id', 'primary_hotel_id'])
    .where('employee_id', '=', employeeId)
    .executeTakeFirstOrThrow();
  // the PIN stops working immediately: replace it with a hash of a random value nobody knows
  await trx
    .updateTable('employee')
    .set({ status: 'inactive', pin_hash: await hashSecret(randomToken()), updated_at: now })
    .where('employee_id', '=', e.employee_id)
    .execute();
  await trx
    .updateTable('refresh_token')
    .set({ revoked_at: now })
    .where('user_id', '=', e.user_id)
    .where('active_employee_id', '=', e.employee_id)
    .where('revoked_at', 'is', null)
    .execute();
  const otherEmp = await trx
    .selectFrom('employee')
    .select('employee_id')
    .where('user_id', '=', e.user_id)
    .where('status', '=', 'active')
    .executeTakeFirst();
  const staff =
    (await trx
      .selectFrom('super_admin')
      .select('user_id')
      .where('user_id', '=', e.user_id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst()) ||
    (await trx
      .selectFrom('admin')
      .select('user_id')
      .where('user_id', '=', e.user_id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst()) ||
    (await trx
      .selectFrom('manager')
      .select('user_id')
      .where('user_id', '=', e.user_id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst());
  let accountDisabled = false;
  if (!otherEmp && !staff) {
    await trx
      .updateTable('user_account')
      .set({ status: 'disabled', updated_at: now })
      .where('id', '=', e.user_id)
      .execute();
    await trx
      .updateTable('refresh_token')
      .set({ revoked_at: now })
      .where('user_id', '=', e.user_id)
      .where('revoked_at', 'is', null)
      .execute();
    accountDisabled = true;
  }
  await audit(trx, actor, {
    action: 'employee_deactivated',
    entityType: 'employee',
    entityId: e.employee_id,
    companyId: e.company_id,
    hotelId: e.primary_hotel_id,
    new: { accountDisabled },
  });
  return { status: 'inactive' as const, accountDisabled };
}
