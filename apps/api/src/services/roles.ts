import type { StaffRolesDto } from '@dienst/shared';
import type { DbOrTrx, Trx } from '../db';
import { notFound } from '../lib/errors';

/** Replaces what an admin may reach: whole companies (admin_company) and single hotels (admin_hotel). */
export async function setAdminAccess(
  trx: Trx,
  adminId: number,
  companyIds: number[],
  hotelIds: number[],
  superAdminId: number,
) {
  for (const id of companyIds)
    if (!(await trx.selectFrom('company').select('id').where('id', '=', id).executeTakeFirst()))
      throw notFound('Company');
  for (const id of hotelIds)
    if (!(await trx.selectFrom('hotel').select('id').where('id', '=', id).executeTakeFirst()))
      throw notFound('Hotel');
  await trx.deleteFrom('admin_company').where('admin_id', '=', adminId).execute();
  await trx.deleteFrom('admin_hotel').where('admin_id', '=', adminId).execute();
  if (companyIds.length)
    await trx
      .insertInto('admin_company')
      .values(companyIds.map((c) => ({ admin_id: adminId, company_id: c, assigned_by_id: superAdminId })))
      .execute();
  if (hotelIds.length)
    await trx
      .insertInto('admin_hotel')
      .values(hotelIds.map((h) => ({ admin_id: adminId, hotel_id: h, assigned_by_id: superAdminId })))
      .execute();
}

export type StaffRoles = StaffRolesDto;

/** The staff roles a person holds right now (revoked roles do not count). */
export async function staffRolesOf(db: DbOrTrx, userId: number): Promise<StaffRoles | null> {
  const u = await db
    .selectFrom('user_account')
    .select(['id', 'email', 'username'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!u) return null;
  const sa = await db
    .selectFrom('super_admin')
    .selectAll()
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  const ad = await db
    .selectFrom('admin')
    .selectAll()
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  const mg = await db
    .selectFrom('manager')
    .selectAll()
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  const emp = await db
    .selectFrom('employee')
    .select(['first_name', 'last_name'])
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .orderBy('employee_id')
    .executeTakeFirst();
  const person = sa ?? ad ?? mg ?? emp;
  return {
    userId,
    name: person ? `${person.first_name} ${person.last_name}` : (u.email ?? u.username ?? ''),
    email: u.email,
    isEmployee: !!emp,
    superAdmin: !!sa,
    admin: ad
      ? {
          companyIds: (
            await db
              .selectFrom('admin_company')
              .select('company_id')
              .where('admin_id', '=', ad.admin_id)
              .execute()
          ).map((x) => x.company_id),
          hotelIds: (
            await db
              .selectFrom('admin_hotel')
              .select('hotel_id')
              .where('admin_id', '=', ad.admin_id)
              .execute()
          ).map((x) => x.hotel_id),
        }
      : null,
    manager: mg
      ? {
          hotelIds: (
            await db
              .selectFrom('manager_hotel')
              .select('hotel_id')
              .where('manager_id', '=', mg.manager_id)
              .execute()
          ).map((x) => x.hotel_id),
        }
      : null,
  };
}
