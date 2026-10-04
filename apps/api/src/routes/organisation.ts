import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql as trxSql } from 'kysely';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { randomToken, sha256 } from '../lib/security';
import { csvIds, idParam, isoDate } from '../lib/http';
import { issueInvitation, sendInvitationMail } from '../services/accounts';
import { resolveHolidayRows } from '../services/holidays';
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
  const companyOut = (c: any) => ({
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
  const hotelOut = (h: any) => ({
    id: h.id,
    companyId: h.company_id,
    name: h.name,
    city: h.city,
    federalState: h.federal_state,
    timezone: h.timezone,
    employeeHoursVisibility: h.employee_hours_visibility,
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
      let q = db
        .selectFrom('hotel')
        .selectAll()
        .where('id', 'in', p.scope.hotelIds.length ? p.scope.hotelIds : [0])
        .orderBy('id');
      if (req.query.companyId) q = q.where('company_id', '=', req.query.companyId);
      return { items: (await q.execute()).map(hotelOut) };
    },
  );

  r.get(
    '/hotels/:id',
    { preValidation: requireRole(SA, AD, MG), schema: { params: idParam } },
    async (req) => {
      getPrincipal(req).scope.assertHotel(req.params.id);
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

  // hotel settings: only the hours-visibility switch is editable in v1; the rest is shown read-only
  const settingsOut = (h: any) => ({
    hotelId: h.id,
    employeeHoursVisibility: h.employee_hours_visibility,
    breakMode: h.break_mode,
    kioskIdentification: h.kiosk_identification,
    allowWebPunch: h.allow_web_punch,
  });
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
  r.put(
    '/hotels/:id/settings',
    {
      preValidation: requireRole(SA, AD),
      schema: {
        params: idParam,
        body: z.object({ employeeHoursVisibility: z.enum(['immediately', 'after_approval']) }),
      },
    },
    async (req) => {
      getPrincipal(req).scope.assertHotel(req.params.id);
      return tx(async (trx) => {
        const old = await trx
          .selectFrom('hotel')
          .selectAll()
          .where('id', '=', req.params.id)
          .executeTakeFirstOrThrow();
        const h = await trx
          .updateTable('hotel')
          .set({ employee_hours_visibility: req.body.employeeHoursVisibility })
          .where('id', '=', old.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'hotel_settings_updated',
          entityType: 'hotel',
          entityId: old.id,
          companyId: old.company_id,
          hotelId: old.id,
          old: { employeeHoursVisibility: old.employee_hours_visibility },
          new: { employeeHoursVisibility: h.employee_hours_visibility },
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

  const adminBody = z.object({
    email: z.email().max(255),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    companyIds: z.array(z.number().int().positive()).min(1),
  });
  r.post('/admins', { preValidation: requireRole(SA), schema: { body: adminBody } }, async (req, reply) => {
    const p = getPrincipal(req);
    const b = req.body;
    const out = await tx(async (trx) => {
      for (const id of b.companyIds)
        if (!(await trx.selectFrom('company').select('id').where('id', '=', id).executeTakeFirst()))
          throw notFound('Company');
      const u = await ensureStaffUser(trx, b.email, app.clock());
      if (await trx.selectFrom('admin').select('admin_id').where('user_id', '=', u.userId).executeTakeFirst())
        throw new AppError('CONFLICT', 'This person is already an admin');
      const a = await trx
        .insertInto('admin')
        .values({
          user_id: u.userId,
          first_name: b.firstName,
          last_name: b.lastName,
          created_by_id: p.superAdminId!,
        })
        .returning('admin_id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('admin_company')
        .values(
          b.companyIds.map((c) => ({ admin_id: a.admin_id, company_id: c, assigned_by_id: p.superAdminId! })),
        )
        .execute();
      await audit(trx, actorOf(req), {
        action: 'admin_created',
        entityType: 'admin',
        entityId: a.admin_id,
        new: { companyIds: b.companyIds },
      });
      return { adminId: a.admin_id, userId: u.userId, invite: u.invite };
    });
    if (out.invite) await sendInvitationMail(app, b.email, b.firstName, out.invite);
    return reply.status(201).send({ adminId: out.adminId, userId: out.userId });
  });

  r.get('/admins', { preValidation: requireRole(SA) }, async () => {
    const rows = await db
      .selectFrom('admin as a')
      .innerJoin('user_account as u', 'u.id', 'a.user_id')
      .select(['a.admin_id', 'a.first_name', 'a.last_name', 'u.email', 'u.status', 'u.last_login_at'])
      .orderBy('a.last_name')
      .execute();
    const links = await db.selectFrom('admin_company').select(['admin_id', 'company_id']).execute();
    return {
      items: rows.map((a) => ({
        adminId: a.admin_id,
        firstName: a.first_name,
        lastName: a.last_name,
        email: a.email,
        status: a.status,
        lastLoginAt: a.last_login_at,
        companyIds: links.filter((l) => l.admin_id === a.admin_id).map((l) => l.company_id),
      })),
    };
  });

  r.put(
    '/admins/:id/companies',
    {
      preValidation: requireRole(SA),
      schema: {
        params: idParam,
        body: z.object({ companyIds: z.array(z.number().int().positive()).min(1) }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      await tx(async (trx) => {
        if (
          !(await trx
            .selectFrom('admin')
            .select('admin_id')
            .where('admin_id', '=', req.params.id)
            .executeTakeFirst())
        )
          throw notFound('Admin');
        const old = await trx
          .selectFrom('admin_company')
          .select('company_id')
          .where('admin_id', '=', req.params.id)
          .execute();
        await trx.deleteFrom('admin_company').where('admin_id', '=', req.params.id).execute();
        await trx
          .insertInto('admin_company')
          .values(
            req.body.companyIds.map((c) => ({
              admin_id: req.params.id,
              company_id: c,
              assigned_by_id: p.superAdminId!,
            })),
          )
          .execute();
        await audit(trx, actorOf(req), {
          action: 'admin_companies_updated',
          entityType: 'admin',
          entityId: req.params.id,
          old: old.map((o) => o.company_id),
          new: req.body.companyIds,
        });
      });
      return { companyIds: req.body.companyIds };
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

  // ---------------------------------------------------------------- departments
  const deptOut = (d: any) => ({ id: d.id, hotelId: d.hotel_id, name: d.name, color: d.color });
  const deptBody = z.object({
    hotelId: z.number().int().positive(),
    name: z.string().min(1).max(100),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullish(),
  });

  r.post(
    '/departments',
    { preValidation: requireRole(SA, AD), schema: { body: deptBody } },
    async (req, reply) => {
      const p = getPrincipal(req);
      p.scope.assertHotel(req.body.hotelId);
      const d = await tx(async (trx) => {
        const row = await trx
          .insertInto('department')
          .values({ hotel_id: req.body.hotelId, name: req.body.name, color: req.body.color ?? null })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'department_created',
          entityType: 'department',
          entityId: row.id,
          hotelId: row.hotel_id,
          new: deptOut(row),
        });
        return row;
      });
      return reply.status(201).send(deptOut(d));
    },
  );

  r.get(
    '/departments',
    { preValidation: requireRole(SA, AD, MG), schema: { querystring: z.object({ hotelId: csvIds }) } },
    async (req) => {
      const p = getPrincipal(req);
      const hotels = p.scope.hotels(req.query.hotelId);
      const rows = hotels.length
        ? await db
            .selectFrom('department')
            .selectAll()
            .where('hotel_id', 'in', hotels)
            .orderBy('hotel_id')
            .orderBy('id')
            .execute()
        : [];
      return { items: rows.map(deptOut) };
    },
  );

  async function loadDept(id: number, p: ReturnType<typeof getPrincipal>, t: Trx | typeof db = db) {
    const d = await t.selectFrom('department').selectAll().where('id', '=', id).executeTakeFirst();
    if (!d) throw notFound('Department');
    p.scope.assertHotel(d.hotel_id);
    return d;
  }

  r.put(
    '/departments/:id',
    {
      preValidation: requireRole(SA, AD),
      schema: { params: idParam, body: deptBody.omit({ hotelId: true }).partial() },
    },
    async (req) => {
      const p = getPrincipal(req);
      return tx(async (trx) => {
        const old = await loadDept(req.params.id, p, trx);
        const row = await trx
          .updateTable('department')
          .set({
            ...(req.body.name !== undefined && { name: req.body.name }),
            ...(req.body.color !== undefined && { color: req.body.color }),
          })
          .where('id', '=', old.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'department_updated',
          entityType: 'department',
          entityId: old.id,
          hotelId: old.hotel_id,
          old: deptOut(old),
          new: deptOut(row),
        });
        return deptOut(row);
      });
    },
  );

  r.delete(
    '/departments/:id',
    { preValidation: requireRole(SA, AD), schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      await tx(async (trx) => {
        const d = await loadDept(req.params.id, p, trx);
        const used =
          (await trx
            .selectFrom('employee')
            .select('employee_id')
            .where('primary_department_id', '=', d.id)
            .limit(1)
            .executeTakeFirst()) ||
          (await trx
            .selectFrom('employee_department')
            .select('employee_id')
            .where('department_id', '=', d.id)
            .limit(1)
            .executeTakeFirst()) ||
          (await trx
            .selectFrom('shift')
            .select('id')
            .where('department_id', '=', d.id)
            .limit(1)
            .executeTakeFirst());
        if (used) throw new AppError('CONFLICT', 'Department is still in use by employees or shifts');
        await trx.deleteFrom('department').where('id', '=', d.id).execute();
        await audit(trx, actorOf(req), {
          action: 'department_deleted',
          entityType: 'department',
          entityId: d.id,
          hotelId: d.hotel_id,
          old: deptOut(d),
        });
      });
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------- kiosk devices
  const deviceOut = (d: any, now: Date) => ({
    id: d.id,
    hotelId: d.hotel_id,
    name: d.name,
    status: d.status,
    lastSeenAt: d.last_seen_at,
    online:
      d.status === 'active' &&
      !!d.last_seen_at &&
      now.getTime() - new Date(d.last_seen_at).getTime() < 3 * 60e3,
  });

  r.post(
    '/kiosk-devices',
    {
      preValidation: requireRole(SA, AD),
      schema: { body: z.object({ hotelId: z.number().int().positive(), name: z.string().min(1).max(100) }) },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      p.scope.assertHotel(req.body.hotelId);
      const token = `kd_${randomToken()}`;
      const row = await tx(async (trx) => {
        const d = await trx
          .insertInto('kiosk_device')
          .values({
            hotel_id: req.body.hotelId,
            name: req.body.name,
            token_hash: sha256(token),
            registered_by_user_id: p.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'kiosk_device_registered',
          entityType: 'kiosk_device',
          entityId: d.id,
          hotelId: d.hotel_id,
          new: { name: d.name },
        });
        return d;
      });
      return reply.status(201).send({ ...deviceOut(row, app.clock()), token });
    },
  );

  r.get(
    '/kiosk-devices',
    { preValidation: requireRole(SA, AD), schema: { querystring: z.object({ hotelId: csvIds }) } },
    async (req) => {
      const p = getPrincipal(req);
      const hotels = p.scope.hotels(req.query.hotelId);
      const rows = hotels.length
        ? await db
            .selectFrom('kiosk_device')
            .selectAll()
            .where('hotel_id', 'in', hotels)
            .orderBy('id')
            .execute()
        : [];
      return { items: rows.map((d) => deviceOut(d, app.clock())) };
    },
  );

  r.put(
    '/kiosk-devices/:id',
    {
      preValidation: requireRole(SA, AD),
      schema: {
        params: idParam,
        body: z.object({
          status: z.enum(['active', 'revoked']).optional(),
          name: z.string().min(1).max(100).optional(),
        }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      return tx(async (trx) => {
        const old = await trx
          .selectFrom('kiosk_device')
          .selectAll()
          .where('id', '=', req.params.id)
          .executeTakeFirst();
        if (!old) throw notFound('Device');
        p.scope.assertHotel(old.hotel_id);
        const row = await trx
          .updateTable('kiosk_device')
          .set({
            ...(req.body.status && { status: req.body.status }),
            ...(req.body.name && { name: req.body.name }),
          })
          .where('id', '=', old.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'kiosk_device_updated',
          entityType: 'kiosk_device',
          entityId: old.id,
          hotelId: old.hotel_id,
          old: { status: old.status, name: old.name },
          new: { status: row.status, name: row.name },
        });
        return deviceOut(row, app.clock());
      });
    },
  );

  // DELETE revokes the device: punch records keep referencing it, so the row is never removed
  r.delete(
    '/kiosk-devices/:id',
    { preValidation: requireRole(SA, AD), schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      await tx(async (trx) => {
        const old = await trx
          .selectFrom('kiosk_device')
          .selectAll()
          .where('id', '=', req.params.id)
          .executeTakeFirst();
        if (!old) throw notFound('Device');
        p.scope.assertHotel(old.hotel_id);
        await trx.updateTable('kiosk_device').set({ status: 'revoked' }).where('id', '=', old.id).execute();
        await audit(trx, actorOf(req), {
          action: 'kiosk_device_revoked',
          entityType: 'kiosk_device',
          entityId: old.id,
          hotelId: old.hotel_id,
        });
      });
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------- holidays
  r.get(
    '/holidays',
    {
      preValidation: requireRole('ANY'),
      schema: {
        querystring: z.object({
          hotelId: z.coerce.number().int().positive(),
          year: z.coerce.number().int().min(2000).max(2100),
        }),
      },
    },
    async (req) => {
      getPrincipal(req).scope.assertHotel(req.query.hotelId);
      const rows = await resolveHolidayRows(
        db,
        req.query.hotelId,
        `${req.query.year}-01-01`,
        `${req.query.year}-12-31`,
      );
      return {
        items: [...rows]
          .map(([date, h]) => ({ id: h.id, date, name: h.name, source: h.scope }))
          .sort((a, b) => a.date.localeCompare(b.date)),
      };
    },
  );

  r.post(
    '/holidays',
    {
      preValidation: requireRole(SA, AD),
      schema: {
        body: z.object({
          scope: z.enum(['company', 'hotel']),
          companyId: z.number().int().optional(),
          hotelId: z.number().int().optional(),
          date: isoDate,
          name: z.string().min(1).max(100),
          isHoliday: z.boolean().default(true),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const b = req.body;
      let companyId: number | null = null;
      let hotelId: number | null = null;
      if (b.scope === 'company') {
        if (!b.companyId) throw new AppError('VALIDATION', 'companyId required');
        p.scope.assertCompany(b.companyId);
        companyId = b.companyId;
      } else {
        if (!b.hotelId) throw new AppError('VALIDATION', 'hotelId required');
        p.scope.assertHotel(b.hotelId);
        hotelId = b.hotelId;
      }
      const row = await tx(async (trx) => {
        const h = await trx
          .insertInto('public_holiday')
          .values({
            scope: b.scope,
            company_id: companyId,
            hotel_id: hotelId,
            date: b.date,
            name: b.name,
            is_holiday: b.isHoliday,
          })
          .onConflict((oc) =>
            oc
              .expression(
                trxSql`scope, COALESCE(federal_state,''), COALESCE(company_id,0), COALESCE(hotel_id,0), date`,
              )
              .doUpdateSet({ name: b.name, is_holiday: b.isHoliday }),
          )
          .returning('id')
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'holiday_added',
          entityType: 'public_holiday',
          entityId: h.id,
          companyId,
          hotelId,
          new: b,
        });
        return h;
      });
      return reply.status(201).send({ id: row.id });
    },
  );

  r.delete(
    '/holidays/:id',
    { preValidation: requireRole(SA, AD), schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      await tx(async (trx) => {
        const h = await trx
          .selectFrom('public_holiday')
          .selectAll()
          .where('id', '=', req.params.id)
          .executeTakeFirst();
        if (!h) throw notFound('Holiday');
        if (h.scope === 'company') p.scope.assertCompany(h.company_id!);
        else if (h.scope === 'hotel') p.scope.assertHotel(h.hotel_id!);
        else
          throw new AppError(
            'FORBIDDEN_SCOPE',
            'National and state holidays cannot be deleted; cancel them with a company or hotel entry',
          );
        await trx.deleteFrom('public_holiday').where('id', '=', h.id).execute();
        await audit(trx, actorOf(req), {
          action: 'holiday_deleted',
          entityType: 'public_holiday',
          entityId: h.id,
          companyId: h.company_id,
          hotelId: h.hotel_id,
          old: { date: h.date, name: h.name },
        });
      });
      return reply.status(204).send();
    },
  );
}
