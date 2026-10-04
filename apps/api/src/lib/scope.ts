import type { Role } from '@dienst/shared';
import type { DbOrTrx } from '../db';
import { forbidden } from './errors';

/**
 * The single scope layer (SPEC 2.1). Resolves which companies and hotels a caller may touch.
 * Every query on hotel- or employee-bound data must filter through this.
 */
export class Scope {
  constructor(
    readonly role: Role,
    readonly companyIds: number[],
    readonly hotelIds: number[],
    readonly employeeId: number | null = null,
  ) {}

  canCompany = (id: number): boolean => this.companyIds.includes(id);
  canHotel = (id: number): boolean => this.hotelIds.includes(id);

  assertCompany(id: number): void {
    if (!this.canCompany(id)) throw forbidden('Company is outside your scope');
  }
  assertHotel(id: number): void {
    if (!this.canHotel(id)) throw forbidden('Hotel is outside your scope');
  }
  /** Intersect requested hotel ids with the scope: any foreign id is rejected, no ids means all of scope. */
  hotels(requested?: number[] | null): number[] {
    if (!requested || !requested.length) return this.hotelIds;
    for (const id of requested) this.assertHotel(id);
    return requested;
  }
}

export interface Principal {
  userId: number;
  role: Role;
  superAdminId: number | null;
  adminId: number | null;
  managerId: number | null;
  employeeId: number | null;
  scope: Scope;
}

export const roleToActorType = (r: Role) =>
  r === 'superAdmin' ? 'super_admin' : r === 'admin' ? 'admin' : r === 'manager' ? 'manager' : 'employee';

export async function buildPrincipal(
  db: DbOrTrx,
  userId: number,
  role: Role,
  employeeId?: number | null,
): Promise<Principal | null> {
  const sa = await db
    .selectFrom('super_admin')
    .select('super_admin_id')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  const ad = await db.selectFrom('admin').select('admin_id').where('user_id', '=', userId).executeTakeFirst();
  const mg = await db
    .selectFrom('manager')
    .select('manager_id')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  const base = {
    userId,
    role,
    superAdminId: sa?.super_admin_id ?? null,
    adminId: ad?.admin_id ?? null,
    managerId: mg?.manager_id ?? null,
    employeeId: null as number | null,
  };

  if (role === 'superAdmin') {
    if (!sa) return null;
    const companies = await db.selectFrom('company').select('id').execute();
    const hotels = await db.selectFrom('hotel').select('id').execute();
    return {
      ...base,
      scope: new Scope(
        role,
        companies.map((c) => c.id),
        hotels.map((h) => h.id),
      ),
    };
  }
  if (role === 'admin') {
    if (!ad) return null;
    const companies = await db
      .selectFrom('admin_company')
      .select('company_id')
      .where('admin_id', '=', ad.admin_id)
      .execute();
    const companyIds = companies.map((c) => c.company_id);
    const hotels = companyIds.length
      ? await db.selectFrom('hotel').select('id').where('company_id', 'in', companyIds).execute()
      : [];
    return {
      ...base,
      scope: new Scope(
        role,
        companyIds,
        hotels.map((h) => h.id),
      ),
    };
  }
  if (role === 'manager') {
    if (!mg) return null;
    const hotels = await db
      .selectFrom('manager_hotel as mh')
      .innerJoin('hotel as h', 'h.id', 'mh.hotel_id')
      .select(['h.id', 'h.company_id'])
      .where('mh.manager_id', '=', mg.manager_id)
      .execute();
    return {
      ...base,
      scope: new Scope(
        role,
        [...new Set(hotels.map((h) => h.company_id))],
        hotels.map((h) => h.id),
      ),
    };
  }
  // employee: exactly the one employee row chosen at role selection
  if (!employeeId) return null;
  const emp = await db
    .selectFrom('employee')
    .select(['employee_id', 'company_id', 'primary_hotel_id'])
    .where('employee_id', '=', employeeId)
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!emp) return null;
  const hs = await db
    .selectFrom('employee_hotel')
    .select('hotel_id')
    .where('employee_id', '=', emp.employee_id)
    .execute();
  const hotelIds = [...new Set([emp.primary_hotel_id, ...hs.map((h) => h.hotel_id)])];
  return {
    ...base,
    employeeId: emp.employee_id,
    scope: new Scope(role, [emp.company_id], hotelIds, emp.employee_id),
  };
}
