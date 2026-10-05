import type { DepartmentDto, KioskDeviceDto } from '@dienst/shared';
import type { DB } from '../db';
import type { Selectable } from 'kysely';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql as trxSql } from 'kysely';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { randomToken, sha256 } from '../lib/security';
import { csvIds, idParam, isoDate } from '../lib/http';
import { resolveHolidayRows } from '../services/holidays';
import type { Trx } from '../db';

const SA = 'superAdmin' as const;
const AD = 'admin' as const;
const MG = 'manager' as const;

export async function departmentRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);

  // ---------------------------------------------------------------- departments
  const deptOut = (d: Selectable<DB['department']>): DepartmentDto => ({
    id: d.id,
    hotelId: d.hotel_id,
    name: d.name,
    color: d.color,
  });
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
  const deviceOut = (d: Selectable<DB['kiosk_device']>, now: Date): KioskDeviceDto => ({
    id: d.id,
    hotelId: d.hotel_id,
    name: d.name,
    status: d.status,
    lastSeenAt: d.last_seen_at ? new Date(d.last_seen_at).toISOString() : null,
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
