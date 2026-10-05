import { z } from 'zod';
import { nextUsername, usernameBase } from '@dienst/rules';
import { randomInt } from 'node:crypto';
import type { Trx } from '../db';
import { AppError, notFound } from '../lib/errors';
import { generatePin, hashSecret } from '../lib/security';
import type { Principal } from '../lib/scope';
import { isoDate } from '../lib/http';
import { issueInvitation } from './accounts';
import { ensureAllowance } from './vacation';

export const employeeCreateSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  dateOfBirth: isoDate,
  email: z
    .email()
    .max(255)
    .nullish()
    .or(z.literal('').transform(() => null)),
  primaryHotelId: z.number().int().positive(),
  primaryDepartmentId: z.number().int().positive(),
  hotelIds: z.array(z.number().int().positive()).optional(),
  departmentIds: z.array(z.number().int().positive()).optional(),
  contractStartDate: isoDate,
  contractEndDate: isoDate.nullish(),
  employmentType: z.enum([
    'full_time',
    'part_time',
    'minijob',
    'werkstudent',
    'apprentice',
    'short_term',
    'other',
  ]),
  workingModel: z.enum(['hourly', 'salary']),
  workDaysPerWeek: z.number().int().min(1).max(7),
  workingWeekdays: z.array(z.number().int().min(1).max(7)).min(1).optional(),
  targetHoursPerWeek: z.number().min(0).max(80).nullish(),
  targetHoursPerMonth: z.number().min(0).max(350).nullish(),
  vacationDaysPerYear: z.number().min(0).max(60),
  vacationDaysAllocatedThisYear: z.number().min(0).max(60).nullish(),
  vacationDaysUsedThisYear: z.number().min(0).max(60).nullish(),
  monthlyHoursCap: z.number().min(0).max(350).nullish(),
  getsPublicHoliday: z.boolean().optional(),
  openingBalanceHours: z.number().min(-1000).max(1000).optional(),
  isFloater: z.boolean().optional(),
  phone: z.string().max(40).nullish(),
  preferredLanguage: z.enum(['de', 'en']).optional(),
});
export type EmployeeCreate = z.infer<typeof employeeCreateSchema>;

export interface CreatedEmployee {
  employeeId: number;
  userId: number;
  username: string | null;
  personnelNumber: string;
  pin: string;
  activation: { method: 'email' | 'code' | 'existing_account'; code?: string; expiresAt?: string };
  /** set when an invitation mail must be sent after the transaction commits */
  mail: { to: string; name: string; token: string } | null;
}

export const weeklyTarget = (
  weekly: number | null | undefined,
  monthly: number | null | undefined,
): number | null => weekly ?? (monthly != null ? (monthly * 12) / 52 : null);

export async function nextPersonnelNumber(trx: Trx, companyId: number): Promise<string> {
  await trx.selectFrom('company').select('id').where('id', '=', companyId).forUpdate().execute(); // serialises numbering
  const rows = await trx
    .selectFrom('employee')
    .select('personnel_number')
    .where('company_id', '=', companyId)
    .execute();
  let max = 99;
  for (const r of rows) {
    const m = /^P(\d+)$/.exec(r.personnel_number);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `P${max + 1}`;
}

export async function generateUsername(trx: Trx, first: string, last: string): Promise<string> {
  let base = usernameBase(first, last);
  if (base.startsWith('.') || base.endsWith('.')) base = `user${String(randomInt(1000000)).padStart(6, '0')}`;
  const rows = await trx
    .selectFrom('user_account')
    .select('username')
    .where('username', 'ilike', `${base}%`)
    .execute();
  return nextUsername(base, new Set(rows.map((r) => (r.username ?? '').toLowerCase())));
}

export async function createEmployee(
  trx: Trx,
  p: Principal,
  b: EmployeeCreate,
  now: Date,
  opts: { pin?: string } = {},
): Promise<CreatedEmployee> {
  p.scope.assertHotel(b.primaryHotelId);
  const hotel = await trx
    .selectFrom('hotel')
    .select(['id', 'company_id'])
    .where('id', '=', b.primaryHotelId)
    .executeTakeFirst();
  if (!hotel) throw notFound('Hotel');
  const companyId = hotel.company_id;
  const company = await trx
    .selectFrom('company')
    .selectAll()
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();

  const hotelIds = [...new Set([b.primaryHotelId, ...(b.hotelIds ?? [])])];
  for (const h of hotelIds) {
    p.scope.assertHotel(h);
    const row = await trx.selectFrom('hotel').select('company_id').where('id', '=', h).executeTakeFirst();
    if (!row || row.company_id !== companyId)
      throw new AppError('VALIDATION', 'All hotels must belong to the same company', { hotelId: h });
  }
  const deptIds = [...new Set([b.primaryDepartmentId, ...(b.departmentIds ?? [])])];
  const depts = await trx
    .selectFrom('department')
    .select(['id', 'hotel_id'])
    .where('id', 'in', deptIds)
    .execute();
  if (depts.length !== deptIds.length) throw new AppError('VALIDATION', 'Unknown department');
  for (const d of depts)
    if (!hotelIds.includes(d.hotel_id))
      throw new AppError('VALIDATION', 'Department belongs to a hotel the employee is not assigned to', {
        departmentId: d.id,
      });
  if (depts.find((d) => d.id === b.primaryDepartmentId)!.hotel_id !== b.primaryHotelId)
    throw new AppError('VALIDATION', 'Primary department must belong to the primary hotel');
  if (b.targetHoursPerWeek == null && b.targetHoursPerMonth == null && b.workingModel === 'salary')
    throw new AppError('VALIDATION', 'Salary contracts need a weekly or monthly target');

  // --- account (SPEC 4.14): reuse by e-mail, otherwise create automatically
  const email = b.email ? b.email.trim() : null;
  let userId: number;
  let username: string | null = null;
  let activation: CreatedEmployee['activation'];
  let mail: CreatedEmployee['mail'] = null;
  const existing = email
    ? await trx
        .selectFrom('user_account')
        .selectAll()
        .where((eb) => eb(eb.fn('lower', ['email']), '=', email.toLowerCase()))
        .executeTakeFirst()
    : undefined;
  if (existing) {
    const dup = await trx
      .selectFrom('employee')
      .select('employee_id')
      .where('user_id', '=', existing.id)
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    if (dup)
      throw new AppError('DUPLICATE_EMPLOYEE', 'This person already has an employment in this company', {
        employeeId: dup.employee_id,
      });
    userId = existing.id;
    username = existing.username ?? existing.email;
    activation = { method: 'existing_account' };
  } else {
    username = await generateUsername(trx, b.firstName, b.lastName);
    const u = await trx
      .insertInto('user_account')
      .values({ email, username, status: 'pending_invite' })
      .returning('id')
      .executeTakeFirstOrThrow();
    userId = u.id;
    if (email) {
      const inv = await issueInvitation(trx, userId, 'email', now);
      activation = { method: 'email', expiresAt: inv.expiresAt.toISOString() };
      mail = { to: email, name: b.firstName, token: inv.secret };
    } else {
      const inv = await issueInvitation(trx, userId, 'code', now);
      activation = { method: 'code', code: inv.secret, expiresAt: inv.expiresAt.toISOString() };
    }
  }

  const pin = opts.pin ?? generatePin(company.pin_length);
  const personnelNumber = await nextPersonnelNumber(trx, companyId);
  const emp = await trx
    .insertInto('employee')
    .values({
      user_id: userId,
      company_id: companyId,
      primary_hotel_id: b.primaryHotelId,
      primary_department_id: b.primaryDepartmentId,
      personnel_number: personnelNumber,
      first_name: b.firstName.trim(),
      last_name: b.lastName.trim(),
      date_of_birth: b.dateOfBirth,
      preferred_language: b.preferredLanguage ?? 'de',
      contact_email: email,
      phone: b.phone ?? null,
      is_floater: b.isFloater ?? false,
      pin_hash: await hashSecret(pin),
      status: 'active',
      opening_balance_hours: b.openingBalanceHours ?? 0,
      contract_start_date: b.contractStartDate,
      contract_end_date: b.contractEndDate ?? null,
      created_by_id: p.adminId,
    })
    .returning('employee_id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('employee_hotel')
    .values(hotelIds.map((h) => ({ employee_id: emp.employee_id, hotel_id: h })))
    .execute();
  await trx
    .insertInto('employee_department')
    .values(deptIds.map((d) => ({ employee_id: emp.employee_id, department_id: d })))
    .execute();

  await insertContract(trx, emp.employee_id, p, {
    validFrom: b.contractStartDate,
    validTo: b.contractEndDate ?? null,
    employmentType: b.employmentType,
    workingModel: b.workingModel,
    workDaysPerWeek: b.workDaysPerWeek,
    workingWeekdays: b.workingWeekdays,
    targetHoursPerWeek: b.targetHoursPerWeek ?? null,
    targetHoursPerMonth: b.targetHoursPerMonth ?? null,
    vacationDaysPerYear: b.vacationDaysPerYear,
    monthlyHoursCap: b.monthlyHoursCap ?? null,
    getsPublicHoliday: b.getsPublicHoliday ?? false,
  });
  await ensureAllowance(trx, emp.employee_id, Number(now.toISOString().slice(0, 4)), {
    allocated: b.vacationDaysAllocatedThisYear ?? undefined,
    used: b.vacationDaysUsedThisYear ?? undefined,
  });
  return { employeeId: emp.employee_id, userId, username, personnelNumber, pin, activation, mail };
}

export const contractSchema = z.object({
  validFrom: isoDate,
  validTo: isoDate.nullish(),
  employmentType: employeeCreateSchema.shape.employmentType,
  workingModel: employeeCreateSchema.shape.workingModel,
  workDaysPerWeek: z.number().int().min(1).max(7),
  workingWeekdays: z.array(z.number().int().min(1).max(7)).min(1).optional(),
  targetHoursPerWeek: z.number().min(0).max(80).nullish(),
  targetHoursPerMonth: z.number().min(0).max(350).nullish(),
  vacationDaysPerYear: z.number().min(0).max(60),
  monthlyHoursCap: z.number().min(0).max(350).nullish(),
  getsPublicHoliday: z.boolean().optional(),
});
export type ContractInput = z.infer<typeof contractSchema>;

export async function insertContract(trx: Trx, employeeId: number, p: Principal, c: ContractInput) {
  const weekly = weeklyTarget(c.targetHoursPerWeek, c.targetHoursPerMonth);
  const days = c.workingWeekdays ?? Array.from({ length: c.workDaysPerWeek }, (_, i) => i + 1);
  return trx
    .insertInto('employee_contract')
    .values({
      employee_id: employeeId,
      valid_from: c.validFrom,
      valid_to: c.validTo ?? null,
      employment_type: c.employmentType,
      working_model: c.workingModel,
      work_days_per_week: c.workDaysPerWeek,
      working_weekdays: days,
      target_hours_per_week: c.targetHoursPerWeek ?? null,
      target_hours_per_month: c.targetHoursPerMonth ?? null,
      daily_target_hours: weekly != null ? Math.round((weekly / c.workDaysPerWeek) * 100) / 100 : null,
      vacation_days_per_year: c.vacationDaysPerYear,
      gets_public_holiday: c.getsPublicHoliday ?? false,
      monthly_hours_cap: c.monthlyHoursCap ?? null,
      created_by_id: p.adminId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
}
