import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { addDays, isMinor } from '@dienst/rules';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { generatePin, hashSecret } from '../lib/security';
import { csvIds, idParam, isoDate, pageQuery, paged } from '../lib/http';
import { issueInvitation, sendInvitationMail } from '../services/accounts';
import {
  contractSchema,
  createEmployee,
  employeeCreateSchema,
  insertContract,
  weeklyTarget,
} from '../services/employees';
import { vacationSummary } from '../services/vacation';
import { deactivateEmployee } from '../services/offboarding';
import { computeTimeAccount } from '../services/timeAccount';
import { localDate } from '../lib/time';
import type { Db, DbOrTrx, Trx } from '../db';
import type { Principal } from '../lib/scope';

const SA = 'superAdmin' as const;
const AD = 'admin' as const;
const MG = 'manager' as const;
const EM = 'employee' as const;

export type EmployeeView = 'full' | 'home' | 'reduced' | 'self';

/** SPEC 4.20: what the caller may see of an employee, or null when out of scope. */
export async function employeeView(db: DbOrTrx, p: Principal, employeeId: number) {
  const e = await db
    .selectFrom('employee')
    .selectAll()
    .where('employee_id', '=', employeeId)
    .executeTakeFirst();
  if (!e) throw notFound('Employee');
  if (p.role === 'superAdmin' || p.role === 'admin') {
    p.scope.assertCompany(e.company_id);
    return { e, view: 'full' as EmployeeView };
  }
  if (p.role === 'employee') {
    if (p.employeeId !== e.employee_id) throw new AppError('FORBIDDEN_SCOPE', 'Not your record');
    return { e, view: 'self' as EmployeeView };
  }
  const hs = await db
    .selectFrom('employee_hotel')
    .select('hotel_id')
    .where('employee_id', '=', employeeId)
    .execute();
  const hotelIds = new Set([e.primary_hotel_id, ...hs.map((h) => h.hotel_id)]);
  if (![...hotelIds].some((h) => p.scope.canHotel(h)))
    throw new AppError('FORBIDDEN_SCOPE', 'Employee is outside your hotels');
  return { e, view: (p.scope.canHotel(e.primary_hotel_id) ? 'home' : 'reduced') as EmployeeView };
}

export async function currentContract(db: DbOrTrx, employeeId: number, date: string) {
  return db
    .selectFrom('employee_contract')
    .selectAll()
    .where('employee_id', '=', employeeId)
    .where('valid_from', '<=', date)
    .orderBy('valid_from', 'desc')
    .limit(1)
    .executeTakeFirst();
}

const contractOut = (c: any) => ({
  id: c.id,
  validFrom: c.valid_from,
  validTo: c.valid_to,
  employmentType: c.employment_type,
  workingModel: c.working_model,
  workDaysPerWeek: c.work_days_per_week,
  workingWeekdays: c.working_weekdays,
  targetHoursPerWeek: c.target_hours_per_week,
  targetHoursPerMonth: c.target_hours_per_month,
  dailyTargetHours: c.daily_target_hours,
  vacationDaysPerYear: c.vacation_days_per_year,
  monthlyHoursCap: c.monthly_hours_cap,
  getsPublicHoliday: c.gets_public_holiday,
});

export async function employeeDetail(db: Db, p: Principal, id: number, today: string, year: number) {
  const { e, view } = await employeeView(db, p, id);
  const hotel = await db
    .selectFrom('hotel')
    .select(['id', 'name'])
    .where('id', '=', e.primary_hotel_id)
    .executeTakeFirstOrThrow();
  const dept = await db
    .selectFrom('department')
    .select(['id', 'name'])
    .where('id', '=', e.primary_department_id)
    .executeTakeFirstOrThrow();
  const base = {
    employeeId: e.employee_id,
    displayName: e.display_name,
    personnelNumber: e.personnel_number,
    homeHotel: { id: hotel.id, name: hotel.name },
    department: { id: dept.id, name: dept.name },
    isFloater: e.is_floater,
    isMinor: isMinor(e.date_of_birth, today),
    status: e.status,
    view,
  };
  if (view === 'reduced') return base;
  const c = await currentContract(db, id, today);
  const weekly = c ? weeklyTarget(c.target_hours_per_week, c.target_hours_per_month) : null;
  const home = {
    ...base,
    workingWeekdays: c?.working_weekdays ?? [],
    workDaysPerWeek: c?.work_days_per_week ?? null,
    targetHoursPerWeek: weekly != null ? Math.round(weekly * 100) / 100 : null,
    employmentType: c?.employment_type ?? null,
    vacation: await vacationSummary(db, id, year),
    timeAccount: await computeTimeAccount(db, id, today),
  };
  if (view === 'home') return home;
  // full (admin/super admin) and self
  const hs = await db.selectFrom('employee_hotel').select('hotel_id').where('employee_id', '=', id).execute();
  const ds = await db
    .selectFrom('employee_department')
    .select('department_id')
    .where('employee_id', '=', id)
    .execute();
  const u = await db
    .selectFrom('user_account')
    .select(['username', 'email', 'status', 'last_login_at'])
    .where('id', '=', e.user_id)
    .executeTakeFirstOrThrow();
  return {
    ...home,
    firstName: e.first_name,
    lastName: e.last_name,
    dateOfBirth: e.date_of_birth,
    email: e.contact_email,
    phone: e.phone,
    preferredLanguage: e.preferred_language,
    workTimeProtection: e.work_time_protection,
    openingBalanceHours: e.opening_balance_hours,
    contractStartDate: e.contract_start_date,
    contractEndDate: e.contract_end_date,
    hotelIds: hs.map((h) => h.hotel_id),
    departmentIds: ds.map((d) => d.department_id),
    contract: c ? contractOut(c) : null,
    pin: { setAt: e.pin_set_at, lockedUntil: e.pin_locked_until, failedCount: e.pin_failed_count },
    account: {
      userId: e.user_id,
      username: u.username,
      email: u.email,
      status: u.status,
      lastLoginAt: u.last_login_at,
    },
  };
}

export async function employeeRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);
  const todayFor = async (hotelId: number) => {
    const h = await db.selectFrom('hotel').select('timezone').where('id', '=', hotelId).executeTakeFirst();
    return localDate(app.clock(), h?.timezone ?? 'Europe/Berlin');
  };

  r.post(
    '/employees',
    { preValidation: requireRole(AD, SA), schema: { body: employeeCreateSchema } },
    async (req, reply) => {
      const p = getPrincipal(req);
      const out = await tx(async (trx) => {
        const c = await createEmployee(trx, p, req.body, app.clock());
        await audit(trx, actorOf(req), {
          action: 'employee_created',
          entityType: 'employee',
          entityId: c.employeeId,
          hotelId: req.body.primaryHotelId,
          companyId: (
            await trx
              .selectFrom('employee')
              .select('company_id')
              .where('employee_id', '=', c.employeeId)
              .executeTakeFirstOrThrow()
          ).company_id,
          new: { personnelNumber: c.personnelNumber, userId: c.userId, activation: c.activation.method },
        });
        return c;
      });
      if (out.mail) await sendInvitationMail(app, out.mail.to, out.mail.name, out.mail.token);
      const { mail: _m, ...body } = out;
      return reply.status(201).send(body);
    },
  );

  r.get(
    '/employees',
    {
      preValidation: requireRole(AD, SA, MG),
      schema: {
        querystring: pageQuery.extend({
          hotelId: z.coerce.number().int().optional(),
          departmentId: z.coerce.number().int().optional(),
          status: z.enum(['active', 'inactive']).optional(),
          q: z.string().max(100).optional(),
        }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      const { page, pageSize, hotelId, departmentId, status, q } = req.query;
      if (hotelId) p.scope.assertHotel(hotelId);
      let qb = db
        .selectFrom('employee as e')
        .innerJoin('hotel as h', 'h.id', 'e.primary_hotel_id')
        .innerJoin('department as d', 'd.id', 'e.primary_department_id')
        .select([
          'e.employee_id',
          'e.first_name',
          'e.last_name',
          'e.display_name',
          'e.personnel_number',
          'e.status',
          'e.is_floater',
          'e.date_of_birth',
          'e.contact_email',
          'e.primary_hotel_id',
          'h.name as hotel_name',
          'd.id as dept_id',
          'd.name as dept_name',
        ]);
      if (p.role === 'manager') {
        const hs = p.scope.hotelIds.length ? p.scope.hotelIds : [0];
        qb = qb.where((eb) =>
          eb.or([
            eb('e.primary_hotel_id', 'in', hs),
            eb.exists(
              eb
                .selectFrom('employee_hotel as eh')
                .select('eh.employee_id')
                .whereRef('eh.employee_id', '=', 'e.employee_id')
                .where('eh.hotel_id', 'in', hs),
            ),
          ]),
        );
      } else {
        qb = qb.where('e.company_id', 'in', p.scope.companyIds.length ? p.scope.companyIds : [0]);
      }
      if (hotelId)
        qb = qb.where((eb) =>
          eb.or([
            eb('e.primary_hotel_id', '=', hotelId),
            eb.exists(
              eb
                .selectFrom('employee_hotel as eh2')
                .select('eh2.employee_id')
                .whereRef('eh2.employee_id', '=', 'e.employee_id')
                .where('eh2.hotel_id', '=', hotelId),
            ),
          ]),
        );
      if (departmentId)
        qb = qb.where((eb) =>
          eb.or([
            eb('e.primary_department_id', '=', departmentId),
            eb.exists(
              eb
                .selectFrom('employee_department as ed')
                .select('ed.employee_id')
                .whereRef('ed.employee_id', '=', 'e.employee_id')
                .where('ed.department_id', '=', departmentId),
            ),
          ]),
        );
      if (status) qb = qb.where('e.status', '=', status);
      if (q) {
        const like = `%${q.replace(/[%_]/g, '')}%`;
        qb = qb.where((eb) =>
          eb.or([
            eb('e.first_name', 'ilike', like),
            eb('e.last_name', 'ilike', like),
            eb('e.personnel_number', 'ilike', like),
          ]),
        );
      }
      const total = Number(
        (
          await db
            .selectFrom(qb.as('x'))
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      );
      const rows = await qb
        .orderBy('e.employee_id')
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .execute();
      const year = Number(app.clock().toISOString().slice(0, 4));
      const items = [];
      const todayStr = localDate(app.clock(), 'Europe/Berlin');
      for (const e of rows) {
        const fullView = p.role !== 'manager' || p.scope.canHotel(e.primary_hotel_id);
        const item: Record<string, unknown> = {
          employeeId: e.employee_id,
          displayName: e.display_name,
          personnelNumber: e.personnel_number,
          department: { id: e.dept_id, name: e.dept_name },
          homeHotel: { id: e.primary_hotel_id, name: e.hotel_name },
          status: e.status,
          isFloater: e.is_floater,
          isMinor: isMinor(e.date_of_birth, todayStr),
          view: fullView ? (p.role === 'manager' ? 'home' : 'full') : 'reduced',
        };
        if (fullView) {
          const today = await todayFor(e.primary_hotel_id);
          const c = await currentContract(db, e.employee_id, today);
          const w = c ? weeklyTarget(c.target_hours_per_week, c.target_hours_per_month) : null;
          item.targetHoursPerWeek = w != null ? Math.round(w * 100) / 100 : null;
          item.employmentType = c?.employment_type ?? null;
          item.vacationRemaining = (await vacationSummary(db, e.employee_id, year)).remaining;
          item.timeAccount = await computeTimeAccount(db, e.employee_id, today);
          if (p.role !== 'manager') {
            item.firstName = e.first_name;
            item.lastName = e.last_name;
            item.email = e.contact_email;
          }
        }
        items.push(item);
      }
      return paged(items, page, pageSize, total);
    },
  );

  r.get(
    '/employees/:id',
    { preValidation: requireRole(AD, SA, MG), schema: { params: idParam } },
    async (req) => {
      const { e } = await employeeView(db, getPrincipal(req), req.params.id);
      const today = await todayFor(e.primary_hotel_id);
      return employeeDetail(db, getPrincipal(req), req.params.id, today, Number(today.slice(0, 4)));
    },
  );

  const updateSchema = z.object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    dateOfBirth: isoDate.optional(),
    email: z.email().nullish(),
    phone: z.string().max(40).nullish(),
    preferredLanguage: z.enum(['de', 'en']).optional(),
    isFloater: z.boolean().optional(),
    workTimeProtection: z.enum(['none', 'maternity']).optional(),
    openingBalanceHours: z.number().min(-1000).max(1000).optional(),
    primaryHotelId: z.number().int().positive().optional(),
    primaryDepartmentId: z.number().int().positive().optional(),
    hotelIds: z.array(z.number().int().positive()).optional(),
    departmentIds: z.array(z.number().int().positive()).optional(),
    contractEndDate: isoDate.nullish(),
  });
  r.put(
    '/employees/:id',
    { preValidation: requireRole(AD, SA), schema: { params: idParam, body: updateSchema } },
    async (req) => {
      const p = getPrincipal(req);
      const b = req.body;
      await tx(async (trx) => {
        const { e } = await employeeView(trx, p, req.params.id);
        const hotelIds =
          b.hotelIds ??
          (
            await trx
              .selectFrom('employee_hotel')
              .select('hotel_id')
              .where('employee_id', '=', e.employee_id)
              .execute()
          ).map((x) => x.hotel_id);
        const deptIds =
          b.departmentIds ??
          (
            await trx
              .selectFrom('employee_department')
              .select('department_id')
              .where('employee_id', '=', e.employee_id)
              .execute()
          ).map((x) => x.department_id);
        const primaryHotel = b.primaryHotelId ?? e.primary_hotel_id;
        const primaryDept = b.primaryDepartmentId ?? e.primary_department_id;
        const hs = [...new Set([primaryHotel, ...hotelIds])];
        const ds = [...new Set([primaryDept, ...deptIds])];
        for (const h of hs) {
          p.scope.assertHotel(h);
          const row = await trx
            .selectFrom('hotel')
            .select('company_id')
            .where('id', '=', h)
            .executeTakeFirst();
          if (!row || row.company_id !== e.company_id)
            throw new AppError('VALIDATION', 'Hotel belongs to another company');
        }
        const drows = await trx
          .selectFrom('department')
          .select(['id', 'hotel_id'])
          .where('id', 'in', ds)
          .execute();
        if (drows.length !== ds.length || drows.some((d) => !hs.includes(d.hotel_id)))
          throw new AppError('VALIDATION', 'Invalid department assignment');
        if (drows.find((d) => d.id === primaryDept)!.hotel_id !== primaryHotel)
          throw new AppError('VALIDATION', 'Primary department must belong to the primary hotel');
        const old = {
          firstName: e.first_name,
          lastName: e.last_name,
          primaryHotelId: e.primary_hotel_id,
          primaryDepartmentId: e.primary_department_id,
          isFloater: e.is_floater,
        };
        await trx
          .updateTable('employee')
          .set({
            ...(b.firstName !== undefined && { first_name: b.firstName }),
            ...(b.lastName !== undefined && { last_name: b.lastName }),
            ...(b.dateOfBirth !== undefined && { date_of_birth: b.dateOfBirth }),
            ...(b.email !== undefined && { contact_email: b.email }),
            ...(b.phone !== undefined && { phone: b.phone }),
            ...(b.preferredLanguage !== undefined && { preferred_language: b.preferredLanguage }),
            ...(b.isFloater !== undefined && { is_floater: b.isFloater }),
            ...(b.workTimeProtection !== undefined && { work_time_protection: b.workTimeProtection }),
            ...(b.openingBalanceHours !== undefined && { opening_balance_hours: b.openingBalanceHours }),
            ...(b.contractEndDate !== undefined && { contract_end_date: b.contractEndDate }),
            primary_hotel_id: primaryHotel,
            primary_department_id: primaryDept,
            updated_at: app.clock(),
          })
          .where('employee_id', '=', e.employee_id)
          .execute();
        await trx.deleteFrom('employee_hotel').where('employee_id', '=', e.employee_id).execute();
        await trx
          .insertInto('employee_hotel')
          .values(hs.map((h) => ({ employee_id: e.employee_id, hotel_id: h })))
          .execute();
        await trx.deleteFrom('employee_department').where('employee_id', '=', e.employee_id).execute();
        await trx
          .insertInto('employee_department')
          .values(ds.map((d) => ({ employee_id: e.employee_id, department_id: d })))
          .execute();
        await audit(trx, actorOf(req), {
          action: 'employee_updated',
          entityType: 'employee',
          entityId: e.employee_id,
          companyId: e.company_id,
          hotelId: primaryHotel,
          old,
          new: { ...b },
        });
      });
      const { e } = await employeeView(db, p, req.params.id);
      const today = await todayFor(e.primary_hotel_id);
      return employeeDetail(db, p, req.params.id, today, Number(today.slice(0, 4)));
    },
  );

  // ---------------------------------------------------------------- contracts
  r.get(
    '/employees/:id/contracts',
    { preValidation: requireRole(AD, SA), schema: { params: idParam } },
    async (req) => {
      await employeeView(db, getPrincipal(req), req.params.id);
      const rows = await db
        .selectFrom('employee_contract')
        .selectAll()
        .where('employee_id', '=', req.params.id)
        .orderBy('valid_from', 'desc')
        .execute();
      return { items: rows.map(contractOut) };
    },
  );

  r.put(
    '/employees/:id/contract',
    { preValidation: requireRole(AD, SA), schema: { params: idParam, body: contractSchema } },
    async (req) => {
      const p = getPrincipal(req);
      const b = req.body;
      const id = await tx(async (trx) => {
        const { e } = await employeeView(trx, p, req.params.id);
        const prev = await trx
          .selectFrom('employee_contract')
          .selectAll()
          .where('employee_id', '=', e.employee_id)
          .orderBy('valid_from', 'desc')
          .limit(1)
          .executeTakeFirst();
        if (prev) {
          if (b.validFrom <= prev.valid_from)
            throw new AppError(
              'VALIDATION',
              'validFrom must be after the start of the current contract version',
            );
          if (prev.valid_to == null || prev.valid_to >= b.validFrom) {
            await trx
              .updateTable('employee_contract')
              .set({ valid_to: addDays(b.validFrom, -1) })
              .where('id', '=', prev.id)
              .execute();
          }
        }
        const row = await insertContract(trx, e.employee_id, p, b);
        await audit(trx, actorOf(req), {
          action: 'contract_changed',
          entityType: 'employee_contract',
          entityId: row.id,
          companyId: e.company_id,
          hotelId: e.primary_hotel_id,
          old: prev ? contractOut(prev) : null,
          new: b,
        });
        return row.id;
      });
      return { contractId: id };
    },
  );

  // ---------------------------------------------------------------- PIN and account actions
  r.post(
    '/employees/:id/reset-pin',
    { preValidation: requireRole(AD, SA), schema: { params: idParam } },
    async (req) => {
      const p = getPrincipal(req);
      return tx(async (trx) => {
        const { e } = await employeeView(trx, p, req.params.id);
        const company = await trx
          .selectFrom('company')
          .select('pin_length')
          .where('id', '=', e.company_id)
          .executeTakeFirstOrThrow();
        const pin = generatePin(company.pin_length);
        await trx
          .updateTable('employee')
          .set({
            pin_hash: await hashSecret(pin),
            pin_set_at: app.clock(),
            pin_failed_count: 0,
            pin_locked_until: null,
          })
          .where('employee_id', '=', e.employee_id)
          .execute();
        await audit(trx, actorOf(req), {
          action: 'pin_reset',
          entityType: 'employee',
          entityId: e.employee_id,
          companyId: e.company_id,
          hotelId: e.primary_hotel_id,
        });
        return { pin };
      });
    },
  );

  r.post(
    '/employees/:id/unlock-pin',
    { preValidation: requireRole(AD, SA), schema: { params: idParam } },
    async (req) => {
      const p = getPrincipal(req);
      return tx(async (trx) => {
        const { e } = await employeeView(trx, p, req.params.id);
        await trx
          .updateTable('employee')
          .set({ pin_failed_count: 0, pin_locked_until: null })
          .where('employee_id', '=', e.employee_id)
          .execute();
        await audit(trx, actorOf(req), {
          action: 'pin_unlocked',
          entityType: 'employee',
          entityId: e.employee_id,
          companyId: e.company_id,
          hotelId: e.primary_hotel_id,
        });
        return { unlocked: true };
      });
    },
  );

  r.post(
    '/employees/:id/resend-invitation',
    { preValidation: requireRole(AD, SA), schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      const out = await tx(async (trx) => {
        const { e } = await employeeView(trx, p, req.params.id);
        const u = await trx
          .selectFrom('user_account')
          .selectAll()
          .where('id', '=', e.user_id)
          .executeTakeFirstOrThrow();
        if (!u.email)
          throw new AppError('VALIDATION', 'The account has no e-mail address; use reset-activation');
        const inv = await issueInvitation(trx, u.id, 'email', app.clock());
        await audit(trx, actorOf(req), {
          action: 'invitation_resent',
          entityType: 'employee',
          entityId: e.employee_id,
          companyId: e.company_id,
          hotelId: e.primary_hotel_id,
        });
        return { to: u.email, name: e.first_name, token: inv.secret };
      });
      await sendInvitationMail(app, out.to, out.name, out.token);
      return reply.status(204).send();
    },
  );

  r.post(
    '/employees/:id/reset-activation',
    { preValidation: requireRole(AD, SA), schema: { params: idParam } },
    async (req) => {
      const p = getPrincipal(req);
      return tx(async (trx) => {
        const { e } = await employeeView(trx, p, req.params.id);
        const u = await trx
          .selectFrom('user_account')
          .selectAll()
          .where('id', '=', e.user_id)
          .executeTakeFirstOrThrow();
        if (u.email)
          throw new AppError(
            'VALIDATION',
            'The account has an e-mail address; use resend-invitation or the reset mail',
          );
        const inv = await issueInvitation(trx, u.id, 'code', app.clock());
        await audit(trx, actorOf(req), {
          action: 'activation_code_reset',
          entityType: 'employee',
          entityId: e.employee_id,
          companyId: e.company_id,
          hotelId: e.primary_hotel_id,
        });
        return { username: u.username, code: inv.secret, expiresAt: inv.expiresAt.toISOString() };
      });
    },
  );

  r.post(
    '/employees/:id/deactivate',
    { preValidation: requireRole(AD, SA), schema: { params: idParam } },
    async (req) => {
      const p = getPrincipal(req);
      return tx(async (trx) => {
        const { e } = await employeeView(trx, p, req.params.id);
        const { accountDisabled } = await deactivateEmployee(trx, e.employee_id, app.clock(), actorOf(req));
        return { status: 'inactive', accountDisabled };
      });
    },
  );

  // ---------------------------------------------------------------- time account
  r.get(
    '/employees/:id/time-account',
    { preValidation: requireRole(AD, SA, MG), schema: { params: idParam } },
    async (req) => {
      const { e, view } = await employeeView(db, getPrincipal(req), req.params.id);
      if (view === 'reduced')
        throw new AppError('FORBIDDEN_SCOPE', 'Only managers of the home hotel see the time account');
      const today = await todayFor(e.primary_hotel_id);
      const balance = await computeTimeAccount(db, e.employee_id, today);
      return { employeeId: e.employee_id, asOf: today, balanceHours: balance };
    },
  );

  void sql;
  void csvIds;
  void EM;
}
