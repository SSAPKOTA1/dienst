import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { csvIds, hhmm, idParam, isoDate } from '../lib/http';
import { loadStaffing } from '../services/staffing';
import type { Trx } from '../db';
import type { Principal } from '../lib/scope';

const SA = 'superAdmin' as const;
const AD = 'admin' as const;
const MG = 'manager' as const;

const shiftOut = (s: any) => ({
  id: s.id,
  hotelId: s.hotel_id,
  departmentId: s.department_id,
  name: s.name,
  startTime: String(s.start_time).slice(0, 5),
  endTime: String(s.end_time).slice(0, 5),
  breakMinutes: s.break_duration_minutes,
});

const staffingBody = z.object({
  weekdayDefaults: z.record(z.string().regex(/^[1-7]$/), z.number().int().min(0).max(500)).default({}),
  overrides: z.array(z.object({ date: isoDate, count: z.number().int().min(0).max(500) })).default([]),
});

export async function shiftRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);

  const body = z.object({
    hotelId: z.number().int().positive(),
    departmentId: z.number().int().positive(),
    name: z.string().min(1).max(100),
    startTime: hhmm,
    endTime: hhmm,
    breakMinutes: z.number().int().min(0).max(240).default(0),
  });

  async function checkDept(trx: Trx | typeof db, hotelId: number, departmentId: number) {
    const d = await trx
      .selectFrom('department')
      .select('hotel_id')
      .where('id', '=', departmentId)
      .executeTakeFirst();
    if (!d || d.hotel_id !== hotelId)
      throw new AppError('VALIDATION', 'The department does not belong to this hotel');
  }
  async function loadShift(trx: Trx | typeof db, p: Principal, id: number) {
    const s = await trx.selectFrom('shift').selectAll().where('id', '=', id).executeTakeFirst();
    if (!s) throw notFound('Shift');
    p.scope.assertHotel(s.hotel_id);
    return s;
  }

  r.post('/shifts', { preValidation: requireRole(SA, AD, MG), schema: { body } }, async (req, reply) => {
    const p = getPrincipal(req);
    const b = req.body;
    p.scope.assertHotel(b.hotelId);
    const row = await tx(async (trx) => {
      await checkDept(trx, b.hotelId, b.departmentId);
      const s = await trx
        .insertInto('shift')
        .values({
          hotel_id: b.hotelId,
          department_id: b.departmentId,
          name: b.name,
          start_time: b.startTime,
          end_time: b.endTime,
          break_duration_minutes: b.breakMinutes,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), {
        action: 'shift_created',
        entityType: 'shift',
        entityId: s.id,
        hotelId: s.hotel_id,
        new: shiftOut(s),
      });
      return s;
    });
    return reply.status(201).send(shiftOut(row));
  });

  r.get(
    '/shifts',
    {
      preValidation: requireRole(SA, AD, MG),
      schema: {
        querystring: z.object({ hotelId: csvIds, departmentId: z.coerce.number().int().optional() }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      const hotels = p.scope.hotels(req.query.hotelId);
      if (!hotels.length) return { items: [] };
      let q = db
        .selectFrom('shift')
        .selectAll()
        .where('hotel_id', 'in', hotels)
        .orderBy('hotel_id')
        .orderBy('department_id')
        .orderBy('start_time')
        .orderBy('id');
      if (req.query.departmentId) q = q.where('department_id', '=', req.query.departmentId);
      const rows = await q.execute();
      const staffing = await loadStaffing(
        db,
        rows.map((s) => s.id),
      );
      return {
        items: rows.map((s) => {
          const st = staffing.get(s.id)!;
          return {
            ...shiftOut(s),
            weekdayDefaults: Object.fromEntries(st.weekdayDefaults),
            overrides: [...st.overrides]
              .map(([date, count]) => ({ date, count }))
              .sort((a, b) => a.date.localeCompare(b.date)),
          };
        }),
      };
    },
  );

  r.put(
    '/shifts/:id',
    {
      preValidation: requireRole(SA, AD, MG),
      schema: { params: idParam, body: body.omit({ hotelId: true }).partial() },
    },
    async (req) => {
      const p = getPrincipal(req);
      const b = req.body;
      return tx(async (trx) => {
        const old = await loadShift(trx, p, req.params.id);
        if (b.departmentId) await checkDept(trx, old.hotel_id, b.departmentId);
        const s = await trx
          .updateTable('shift')
          .set({
            ...(b.departmentId !== undefined && { department_id: b.departmentId }),
            ...(b.name !== undefined && { name: b.name }),
            ...(b.startTime !== undefined && { start_time: b.startTime }),
            ...(b.endTime !== undefined && { end_time: b.endTime }),
            ...(b.breakMinutes !== undefined && { break_duration_minutes: b.breakMinutes }),
          })
          .where('id', '=', old.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'shift_updated',
          entityType: 'shift',
          entityId: old.id,
          hotelId: old.hotel_id,
          old: shiftOut(old),
          new: shiftOut(s),
        });
        return shiftOut(s);
      });
    },
  );

  r.delete(
    '/shifts/:id',
    { preValidation: requireRole(SA, AD, MG), schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      await tx(async (trx) => {
        const s = await loadShift(trx, p, req.params.id);
        const used = await trx
          .selectFrom('schedule')
          .select('id')
          .where('shift_id', '=', s.id)
          .limit(1)
          .executeTakeFirst();
        if (used) throw new AppError('CONFLICT', 'The shift is used in the schedule and cannot be deleted');
        await trx.deleteFrom('shift_staffing_requirement').where('shift_id', '=', s.id).execute();
        await trx.deleteFrom('shift').where('id', '=', s.id).execute();
        await audit(trx, actorOf(req), {
          action: 'shift_deleted',
          entityType: 'shift',
          entityId: s.id,
          hotelId: s.hotel_id,
          old: shiftOut(s),
        });
      });
      return reply.status(204).send();
    },
  );

  // ---- staffing (SPEC 5.3): PUT replaces the weekday defaults and the date overrides of the shift
  r.put(
    '/shifts/:id/staffing',
    { preValidation: requireRole(SA, AD, MG), schema: { params: idParam, body: staffingBody } },
    async (req) => {
      const p = getPrincipal(req);
      const b = req.body;
      return tx(async (trx) => {
        const s = await loadShift(trx, p, req.params.id);
        const old = (await loadStaffing(trx, [s.id])).get(s.id)!;
        await trx.deleteFrom('shift_staffing_requirement').where('shift_id', '=', s.id).execute();
        const rows = [
          ...Object.entries(b.weekdayDefaults).map(([wd, n]) => ({
            shift_id: s.id,
            weekday: Number(wd),
            on_date: null,
            required_headcount: n,
          })),
          ...[...new Map(b.overrides.map((o) => [o.date, o.count]))].map(([date, n]) => ({
            shift_id: s.id,
            weekday: null,
            on_date: date,
            required_headcount: n,
          })),
        ];
        if (rows.length) await trx.insertInto('shift_staffing_requirement').values(rows).execute();
        await audit(trx, actorOf(req), {
          action: 'staffing_updated',
          entityType: 'shift',
          entityId: s.id,
          hotelId: s.hotel_id,
          old: {
            weekdayDefaults: Object.fromEntries(old.weekdayDefaults),
            overrides: Object.fromEntries(old.overrides),
          },
          new: b,
        });
        return b;
      });
    },
  );

  r.get(
    '/shifts/:id/staffing',
    { preValidation: requireRole(SA, AD, MG), schema: { params: idParam } },
    async (req) => {
      const s = await loadShift(db, getPrincipal(req), req.params.id);
      const st = (await loadStaffing(db, [s.id])).get(s.id)!;
      return {
        weekdayDefaults: Object.fromEntries(st.weekdayDefaults),
        overrides: [...st.overrides]
          .map(([date, count]) => ({ date, count }))
          .sort((a, b) => a.date.localeCompare(b.date)),
      };
    },
  );
}
