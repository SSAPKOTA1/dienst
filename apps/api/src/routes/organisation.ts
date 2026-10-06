import type { CompanyDto, HotelDto, HotelSettingsDto } from '@dienst/shared';
import type { DB } from '../db';
import type { Selectable } from 'kysely';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { cidrList } from '../lib/net';
import { idParam } from '../lib/http';
import { issueInvitation, sendInvitationMail } from '../services/accounts';
import { setAdminAccess } from '../services/roles';
import type { Trx } from '../db';

const SA = 'superAdmin' as const;
const AD = 'admin' as const;
const MG = 'manager' as const;

export async function organisationRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);

  // ---------------------------------------------------------------- companies
  const companyBody = z.object({
    name: z.string().min(1).max(255),
    graceMinutes: z.number().int().min(0).max(60).optional(),
    sickBackdateDays: z.number().int().min(0).max(60).optional(),
    pinLength: z.number().int().min(4).max(8).optional(),
  });
  const companyOut = (c: Selectable<DB['company']>): CompanyDto => ({
    id: c.id,
    name: c.name,
    graceMinutes: c.grace_period_minutes,
    sickBackdateDays: c.sick_backdate_days,
    pinLength: c.pin_length,
  });

  r.post(
    '/companies',
    { preValidation: requireRole(SA), schema: { body: companyBody } },
    async (req, reply) => {
      const p = getPrincipal(req);
      const b = req.body;
      const row = await tx(async (trx) => {
        const c = await trx
          .insertInto('company')
          .values({
            name: b.name,
            grace_period_minutes: b.graceMinutes ?? 15,
            sick_backdate_days: b.sickBackdateDays ?? 7,
            pin_length: b.pinLength ?? 6,
            created_by_id: p.superAdminId!,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'company_created',
          entityType: 'company',
          entityId: c.id,
          companyId: c.id,
          new: b,
        });
        return c;
      });
      return reply.status(201).send(companyOut(row));
    },
  );

  r.get('/companies', { preValidation: requireRole(SA, AD) }, async (req) => {
    const p = getPrincipal(req);
    const rows = await db
      .selectFrom('company')
      .selectAll()
      .where('id', 'in', p.scope.companyIds.length ? p.scope.companyIds : [0])
      .orderBy('id')
      .execute();
    return { items: rows.map(companyOut) };
  });

  r.put(
    '/companies/:id',
    { preValidation: requireRole(SA), schema: { params: idParam, body: companyBody.partial() } },
    async (req) => {
      const b = req.body;
      return tx(async (trx) => {
        const old = await trx
          .selectFrom('company')
          .selectAll()
          .where('id', '=', req.params.id)
          .executeTakeFirst();
        if (!old) throw notFound('Company');
        const row = await trx
          .updateTable('company')
          .set({
            ...(b.name !== undefined && { name: b.name }),
            ...(b.graceMinutes !== undefined && { grace_period_minutes: b.graceMinutes }),
            ...(b.sickBackdateDays !== undefined && { sick_backdate_days: b.sickBackdateDays }),
            ...(b.pinLength !== undefined && { pin_length: b.pinLength }),
          })
          .where('id', '=', old.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'company_updated',
          entityType: 'company',
          entityId: old.id,
          companyId: old.id,
          old: companyOut(old),
          new: companyOut(row),
        });
        return companyOut(row);
      });
    },
  );

  // ---------------------------------------------------------------- hotels
  const hotelOut = (h: Selectable<DB['hotel']>): HotelDto => ({
    id: h.id,
    companyId: h.company_id,
    name: h.name,
    city: h.city,
    federalState: h.federal_state,
    timezone: h.timezone,
    employeeHoursVisibility: h.employee_hours_visibility,
    isActive: h.is_active,
  });
  const hotelBody = z.object({
    companyId: z.number().int().positive(),
    name: z.string().min(1).max(255),
    city: z.string().max(100).nullish(),
    federalState: z.string().length(2).nullish(),
    timezone: z.string().min(3).max(50).optional(),
  });

  r.post('/hotels', { preValidation: requireRole(SA), schema: { body: hotelBody } }, async (req, reply) => {
    const b = req.body;
    const row = await tx(async (trx) => {
      const co = await trx
        .selectFrom('company')
        .select('id')
        .where('id', '=', b.companyId)
        .executeTakeFirst();
      if (!co) throw notFound('Company');
      const h = await trx
        .insertInto('hotel')
        .values({
          company_id: b.companyId,
          name: b.name,
          city: b.city ?? null,
          federal_state: b.federalState ?? null,
          timezone: b.timezone ?? 'Europe/Berlin',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), {
        action: 'hotel_created',
        entityType: 'hotel',
        entityId: h.id,
        companyId: h.company_id,
        hotelId: h.id,
        new: hotelOut(h),
      });
      return h;
    });
    return reply.status(201).send(hotelOut(row));
  });

  r.get(
    '/hotels',
    {
      preValidation: requireRole(SA, AD, MG),
      schema: { querystring: z.object({ companyId: z.coerce.number().optional() }) },
    },
    async (req) => {
      const p = getPrincipal(req);
      // everyone else sees active hotels in scope only; the super admin also needs the switched-off ones to reactivate them
      let q = db.selectFrom('hotel').selectAll().orderBy('id');
      if (p.role !== 'superAdmin') q = q.where('id', 'in', p.scope.hotelIds.length ? p.scope.hotelIds : [0]);
      if (req.query.companyId) q = q.where('company_id', '=', req.query.companyId);
      return { items: (await q.execute()).map(hotelOut) };
    },
  );

  r.get(
    '/hotels/:id',
    { preValidation: requireRole(SA, AD, MG), schema: { params: idParam } },
    async (req) => {
      const p = getPrincipal(req);
      if (p.role !== 'superAdmin') p.scope.assertHotel(req.params.id);
      const h = await db.selectFrom('hotel').selectAll().where('id', '=', req.params.id).executeTakeFirst();
      if (!h) throw notFound('Hotel');
      return hotelOut(h);
    },
  );

  r.put(
    '/hotels/:id',
    {
      preValidation: requireRole(SA),
      schema: { params: idParam, body: hotelBody.omit({ companyId: true }).partial() },
    },
    async (req) => {
      const b = req.body;
      return tx(async (trx) => {
        const old = await trx
          .selectFrom('hotel')
          .selectAll()
          .where('id', '=', req.params.id)
          .executeTakeFirst();
        if (!old) throw notFound('Hotel');
        const h = await trx
          .updateTable('hotel')
          .set({
            ...(b.name !== undefined && { name: b.name }),
            ...(b.city !== undefined && { city: b.city }),
            ...(b.federalState !== undefined && { federal_state: b.federalState }),
            ...(b.timezone !== undefined && { timezone: b.timezone }),
          })
          .where('id', '=', old.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'hotel_updated',
          entityType: 'hotel',
          entityId: old.id,
          companyId: old.company_id,
          hotelId: old.id,
          old: hotelOut(old),
          new: hotelOut(h),
        });
        return hotelOut(h);
      });
    },
  );

  // hotel settings: hours visibility (v1) and the platform options (break mode, badge, web punch)
  const settingsOut = (h: Selectable<DB['hotel']>): HotelSettingsDto => ({
    hotelId: h.id,
    employeeHoursVisibility: h.employee_hours_visibility,
    breakMode: h.break_mode,
    kioskIdentification: h.kiosk_identification,
    allowWebPunch: h.allow_web_punch,
    webPunchAllowedCidrs: h.web_punch_allowed_cidrs ?? [],
  });
  r.put(
    '/hotels/:id/active',
    {
      preValidation: requireRole(SA),
      schema: { params: idParam, body: z.object({ active: z.boolean() }) },
    },
    async (req) => {
      const { active } = req.body;
      return tx(async (trx) => {
        const old = await trx
          .selectFrom('hotel')
          .selectAll()
          .where('id', '=', req.params.id)
          .executeTakeFirst();
        if (!old) throw notFound('Hotel');
        if (old.is_active === active) return hotelOut(old);
        if (!active) {
          // someone still clocked in would be stuck without a tablet to clock out on
          const open = await trx
            .selectFrom('punch_record')
            .select('id')
            .where('hotel_id', '=', old.id)
            .where('actual_punch_out', 'is', null)
            .executeTakeFirst();
          if (open)
            throw new AppError('CONFLICT', 'The hotel still has open time records. Close them first.', {
              code: 'HOTEL_HAS_OPEN_PUNCHES',
            });
        }
        const h = await trx
          .updateTable('hotel')
          .set({ is_active: active, deactivated_at: active ? null : app.clock() })
          .where('id', '=', old.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: active ? 'hotel_activated' : 'hotel_deactivated',
          entityType: 'hotel',
          entityId: old.id,
          companyId: old.company_id,
          hotelId: old.id,
          old: { isActive: old.is_active },
          new: { isActive: active },
        });
        return hotelOut(h);
      });
    },
  );

  r.get(
    '/hotels/:id/settings',
    { preValidation: requireRole(SA, AD, MG), schema: { params: idParam } },
    async (req) => {
      getPrincipal(req).scope.assertHotel(req.params.id);
      const h = await db.selectFrom('hotel').selectAll().where('id', '=', req.params.id).executeTakeFirst();
      if (!h) throw notFound('Hotel');
      return settingsOut(h);
    },
  );
  const settingsBody = z
    .object({
      employeeHoursVisibility: z.enum(['immediately', 'after_approval']),
      breakMode: z.enum(['confirm_at_clock_out', 'start_stop']),
      kioskIdentification: z.enum(['name_pin', 'badge_pin']),
      allowWebPunch: z.boolean(),
      webPunchAllowedCidrs: cidrList,
    })
    .partial()
    .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
  r.put(
    '/hotels/:id/settings',
    {
      preValidation: requireRole(SA, AD),
      schema: { params: idParam, body: settingsBody },
    },
    async (req) => {
      getPrincipal(req).scope.assertHotel(req.params.id);
      const b = req.body;
      return tx(async (trx) => {
        const old = await trx
          .selectFrom('hotel')
          .selectAll()
          .where('id', '=', req.params.id)
          .executeTakeFirstOrThrow();
        const allow = b.allowWebPunch ?? old.allow_web_punch;
        const cidrs = b.webPunchAllowedCidrs ?? old.web_punch_allowed_cidrs ?? [];
        if (allow && !cidrs.length)
          throw new AppError('VALIDATION', 'Web punch needs at least one allowed network (CIDR)', {
            field: 'webPunchAllowedCidrs',
          });
        const h = await trx
          .updateTable('hotel')
          .set({
            ...(b.employeeHoursVisibility ? { employee_hours_visibility: b.employeeHoursVisibility } : {}),
            ...(b.breakMode ? { break_mode: b.breakMode } : {}),
            ...(b.kioskIdentification ? { kiosk_identification: b.kioskIdentification } : {}),
            ...(b.allowWebPunch !== undefined ? { allow_web_punch: b.allowWebPunch } : {}),
            ...(b.webPunchAllowedCidrs ? { web_punch_allowed_cidrs: b.webPunchAllowedCidrs } : {}),
          })
          .where('id', '=', old.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'hotel_settings_updated',
          entityType: 'hotel',
          entityId: old.id,
          companyId: old.company_id,
          hotelId: old.id,
          old: settingsOut(old),
          new: settingsOut(h),
        });
        return settingsOut(h);
      });
    },
  );

  // ---------------------------------------------------------------- admins (super admin)
  async function ensureStaffUser(trx: Trx, email: string, now: Date) {
    const existing = await trx
      .selectFrom('user_account')
      .select(['id', 'status'])
      .where((eb) => eb(eb.fn('lower', ['email']), '=', email.toLowerCase()))
      .executeTakeFirst();
    if (existing) return { userId: existing.id, invite: null as string | null, reused: true };
    const u = await trx
      .insertInto('user_account')
      .values({ email, status: 'pending_invite' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const inv = await issueInvitation(trx, u.id, 'email', now);
    return { userId: u.id, invite: inv.secret, reused: false };
  }

  const adminBody = z
    .object({
      email: z.email().max(255),
      firstName: z.string().min(1).max(100),
      lastName: z.string().min(1).max(100),
      /** whole companies: the admin sees and manages all their hotels */
      companyIds: z.array(z.number().int().positive()).default([]),
      /** single hotels: the admin is limited to these */
      hotelIds: z.array(z.number().int().positive()).default([]),
    })
    .refine((b) => b.companyIds.length + b.hotelIds.length > 0, {
      message: 'Assign at least one company or hotel',
    });

  r.post('/admins', { preValidation: requireRole(SA), schema: { body: adminBody } }, async (req, reply) => {
    const p = getPrincipal(req);
    const b = req.body;
    const out = await tx(async (trx) => {
      const u = await ensureStaffUser(trx, b.email, app.clock());
      const existing = await trx
        .selectFrom('admin')
        .select(['admin_id', 'revoked_at'])
        .where('user_id', '=', u.userId)
        .executeTakeFirst();
      if (existing && !existing.revoked_at) throw new AppError('CONFLICT', 'This person is already an admin');
      let adminId: number;
      if (existing) {
        // a revoked admin comes back with the data they had
        adminId = existing.admin_id;
        await trx
          .updateTable('admin')
          .set({ revoked_at: null, first_name: b.firstName, last_name: b.lastName, updated_at: app.clock() })
          .where('admin_id', '=', adminId)
          .execute();
      } else {
        adminId = (
          await trx
            .insertInto('admin')
            .values({
              user_id: u.userId,
              first_name: b.firstName,
              last_name: b.lastName,
              created_by_id: p.superAdminId!,
            })
            .returning('admin_id')
            .executeTakeFirstOrThrow()
        ).admin_id;
      }
      await setAdminAccess(trx, adminId, b.companyIds, b.hotelIds, p.superAdminId!);
      await audit(trx, actorOf(req), {
        action: 'admin_created',
        entityType: 'admin',
        entityId: adminId,
        new: { companyIds: b.companyIds, hotelIds: b.hotelIds },
      });
      return { adminId, userId: u.userId, invite: u.invite };
    });
    if (out.invite) await sendInvitationMail(app, b.email, b.firstName, out.invite);
    return reply.status(201).send({ adminId: out.adminId, userId: out.userId });
  });

  r.get('/admins', { preValidation: requireRole(SA) }, async () => {
    const rows = await db
      .selectFrom('admin as a')
      .innerJoin('user_account as u', 'u.id', 'a.user_id')
      .select(['a.admin_id', 'a.first_name', 'a.last_name', 'u.email', 'u.status', 'u.last_login_at'])
      .where('a.revoked_at', 'is', null)
      .orderBy('a.last_name')
      .execute();
    const links = await db.selectFrom('admin_company').select(['admin_id', 'company_id']).execute();
    const hotelLinks = await db.selectFrom('admin_hotel').select(['admin_id', 'hotel_id']).execute();
    return {
      items: rows.map((a) => ({
        adminId: a.admin_id,
        firstName: a.first_name,
        lastName: a.last_name,
        email: a.email,
        status: a.status,
        lastLoginAt: a.last_login_at,
        companyIds: links.filter((l) => l.admin_id === a.admin_id).map((l) => l.company_id),
        hotelIds: hotelLinks.filter((l) => l.admin_id === a.admin_id).map((l) => l.hotel_id),
      })),
    };
  });

  const superAdminBody = z.object({
    email: z.email().max(255),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
  });
  r.post(
    '/super-admins',
    { preValidation: requireRole(SA), schema: { body: superAdminBody } },
    async (req, reply) => {
      const b = req.body;
      const out = await tx(async (trx) => {
        const u = await ensureStaffUser(trx, b.email, app.clock());
        const existing = await trx
          .selectFrom('super_admin')
          .select(['super_admin_id', 'revoked_at'])
          .where('user_id', '=', u.userId)
          .executeTakeFirst();
        if (existing && !existing.revoked_at)
          throw new AppError('CONFLICT', 'This person is already a super admin');
        let superAdminId: number;
        if (existing) {
          superAdminId = existing.super_admin_id;
          await trx
            .updateTable('super_admin')
            .set({
              revoked_at: null,
              first_name: b.firstName,
              last_name: b.lastName,
              updated_at: app.clock(),
            })
            .where('super_admin_id', '=', superAdminId)
            .execute();
        } else {
          superAdminId = (
            await trx
              .insertInto('super_admin')
              .values({ user_id: u.userId, first_name: b.firstName, last_name: b.lastName })
              .returning('super_admin_id')
              .executeTakeFirstOrThrow()
          ).super_admin_id;
        }
        await audit(trx, actorOf(req), {
          action: 'super_admin_created',
          entityType: 'super_admin',
          entityId: superAdminId,
        });
        return { superAdminId, userId: u.userId, invite: u.invite };
      });
      if (out.invite) await sendInvitationMail(app, b.email, b.firstName, out.invite);
      return reply.status(201).send({ superAdminId: out.superAdminId, userId: out.userId });
    },
  );

  r.put(
    '/admins/:id/companies',
    {
      preValidation: requireRole(SA),
      schema: { params: idParam, body: z.object({ companyIds: z.array(z.number().int().positive()) }) },
    },
    async (req) => {
      const p = getPrincipal(req);
      const { companyIds } = req.body;
      await tx(async (trx) => {
        if (
          !(await trx
            .selectFrom('admin')
            .select('admin_id')
            .where('admin_id', '=', req.params.id)
            .where('revoked_at', 'is', null)
            .executeTakeFirst())
        )
          throw notFound('Admin');
        const oldCompanies = await trx
          .selectFrom('admin_company')
          .select('company_id')
          .where('admin_id', '=', req.params.id)
          .execute();
        const hotels = (
          await trx
            .selectFrom('admin_hotel')
            .select('hotel_id')
            .where('admin_id', '=', req.params.id)
            .execute()
        ).map((h) => h.hotel_id);
        if (!companyIds.length && !hotels.length)
          throw new AppError('VALIDATION', 'Assign at least one company or hotel');
        await setAdminAccess(trx, req.params.id, companyIds, hotels, p.superAdminId!);
        await audit(trx, actorOf(req), {
          action: 'admin_companies_updated',
          entityType: 'admin',
          entityId: req.params.id,
          old: oldCompanies.map((o) => o.company_id),
          new: companyIds,
        });
      });
      return { companyIds };
    },
  );

  const adminAccessBody = z.object({
    companyIds: z.array(z.number().int().positive()),
    hotelIds: z.array(z.number().int().positive()),
  });
  /** Replaces everything an admin may reach (whole companies and single hotels) in one step. */
  r.put(
    '/admins/:id/access',
    { preValidation: requireRole(SA), schema: { params: idParam, body: adminAccessBody } },
    async (req) => {
      const p = getPrincipal(req);
      const { companyIds, hotelIds } = req.body;
      if (!companyIds.length && !hotelIds.length)
        throw new AppError('VALIDATION', 'Assign at least one company or hotel');
      await tx(async (trx) => {
        if (
          !(await trx
            .selectFrom('admin')
            .select('admin_id')
            .where('admin_id', '=', req.params.id)
            .where('revoked_at', 'is', null)
            .executeTakeFirst())
        )
          throw notFound('Admin');
        const oldCompanies = await trx
          .selectFrom('admin_company')
          .select('company_id')
          .where('admin_id', '=', req.params.id)
          .execute();
        const oldHotels = await trx
          .selectFrom('admin_hotel')
          .select('hotel_id')
          .where('admin_id', '=', req.params.id)
          .execute();
        await setAdminAccess(trx, req.params.id, companyIds, hotelIds, p.superAdminId!);
        await audit(trx, actorOf(req), {
          action: 'admin_access_updated',
          entityType: 'admin',
          entityId: req.params.id,
          old: {
            companyIds: oldCompanies.map((o) => o.company_id),
            hotelIds: oldHotels.map((o) => o.hotel_id),
          },
          new: { companyIds, hotelIds },
        });
      });
      return { companyIds, hotelIds };
    },
  );

  // ---------------------------------------------------------------- managers (SA, AD)
  const managerBody = z.object({
    email: z.email().max(255),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    hotelIds: z.array(z.number().int().positive()).min(1),
  });
  r.post(
    '/managers',
    { preValidation: requireRole(SA, AD), schema: { body: managerBody } },
    async (req, reply) => {
      const p = getPrincipal(req);
      const b = req.body;
      for (const h of b.hotelIds) p.scope.assertHotel(h);
      const out = await tx(async (trx) => {
        const u = await ensureStaffUser(trx, b.email, app.clock());
        if (
          await trx
            .selectFrom('manager')
            .select('manager_id')
            .where('user_id', '=', u.userId)
            .executeTakeFirst()
        )
          throw new AppError('CONFLICT', 'This person is already a manager');
        const m = await trx
          .insertInto('manager')
          .values({
            user_id: u.userId,
            first_name: b.firstName,
            last_name: b.lastName,
            created_by_id: p.adminId,
          })
          .returning('manager_id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('manager_hotel')
          .values(b.hotelIds.map((h) => ({ manager_id: m.manager_id, hotel_id: h })))
          .execute();
        await audit(trx, actorOf(req), {
          action: 'manager_created',
          entityType: 'manager',
          entityId: m.manager_id,
          new: { hotelIds: b.hotelIds, reusedAccount: u.reused },
        });
        return { managerId: m.manager_id, userId: u.userId, invite: u.invite };
      });
      if (out.invite) await sendInvitationMail(app, b.email, b.firstName, out.invite);
      return reply.status(201).send({ managerId: out.managerId, userId: out.userId });
    },
  );

  r.get('/managers', { preValidation: requireRole(SA, AD) }, async (req) => {
    const p = getPrincipal(req);
    const links = await db
      .selectFrom('manager_hotel')
      .select(['manager_id', 'hotel_id'])
      .where('hotel_id', 'in', p.scope.hotelIds.length ? p.scope.hotelIds : [0])
      .execute();
    const ids = [...new Set(links.map((l) => l.manager_id))];
    const rows = ids.length
      ? await db
          .selectFrom('manager as m')
          .innerJoin('user_account as u', 'u.id', 'm.user_id')
          .select(['m.manager_id', 'm.first_name', 'm.last_name', 'u.email', 'u.status', 'u.last_login_at'])
          .where('m.manager_id', 'in', ids)
          .orderBy('m.last_name')
          .execute()
      : [];
    return {
      items: rows.map((m) => ({
        managerId: m.manager_id,
        firstName: m.first_name,
        lastName: m.last_name,
        email: m.email,
        status: m.status,
        lastLoginAt: m.last_login_at,
        hotelIds: links.filter((l) => l.manager_id === m.manager_id).map((l) => l.hotel_id),
      })),
    };
  });

  r.put(
    '/managers/:id',
    {
      preValidation: requireRole(SA, AD),
      schema: {
        params: idParam,
        body: z.object({ firstName: z.string().min(1).max(100), lastName: z.string().min(1).max(100) }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      await tx(async (trx) => {
        const links = await trx
          .selectFrom('manager_hotel')
          .select('hotel_id')
          .where('manager_id', '=', req.params.id)
          .execute();
        if (!links.some((l) => p.scope.canHotel(l.hotel_id)))
          throw links.length ? new AppError('FORBIDDEN_SCOPE', 'Outside your scope') : notFound('Manager');
        await trx
          .updateTable('manager')
          .set({ first_name: req.body.firstName, last_name: req.body.lastName, updated_at: app.clock() })
          .where('manager_id', '=', req.params.id)
          .execute();
        await audit(trx, actorOf(req), {
          action: 'manager_updated',
          entityType: 'manager',
          entityId: req.params.id,
          new: req.body,
        });
      });
      return { ok: true };
    },
  );

  r.put(
    '/managers/:id/hotels',
    {
      preValidation: requireRole(SA, AD),
      schema: { params: idParam, body: z.object({ hotelIds: z.array(z.number().int().positive()) }) },
    },
    async (req) => {
      const p = getPrincipal(req);
      for (const h of req.body.hotelIds) p.scope.assertHotel(h);
      await tx(async (trx) => {
        const cur = await trx
          .selectFrom('manager_hotel')
          .select('hotel_id')
          .where('manager_id', '=', req.params.id)
          .execute();
        if (
          !cur.length &&
          !(await trx
            .selectFrom('manager')
            .select('manager_id')
            .where('manager_id', '=', req.params.id)
            .executeTakeFirst())
        )
          throw notFound('Manager');
        if (cur.length && !cur.some((c) => p.scope.canHotel(c.hotel_id)) && !req.body.hotelIds.length)
          throw new AppError('FORBIDDEN_SCOPE', 'Outside your scope');
        // an admin only replaces assignments inside their own scope
        const keep = cur.filter((c) => !p.scope.canHotel(c.hotel_id)).map((c) => c.hotel_id);
        await trx.deleteFrom('manager_hotel').where('manager_id', '=', req.params.id).execute();
        const all = [...new Set([...keep, ...req.body.hotelIds])];
        if (all.length)
          await trx
            .insertInto('manager_hotel')
            .values(all.map((h) => ({ manager_id: req.params.id, hotel_id: h })))
            .execute();
        await audit(trx, actorOf(req), {
          action: 'manager_hotels_updated',
          entityType: 'manager',
          entityId: req.params.id,
          old: cur.map((c) => c.hotel_id),
          new: all,
        });
      });
      return { hotelIds: req.body.hotelIds };
    },
  );
}
