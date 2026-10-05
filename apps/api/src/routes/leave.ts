import type { BlackoutDto, ShiftWishDto, LeaveWishDto } from '@dienst/shared';
import type { DB } from '../db';
import type { Selectable } from 'kysely';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { csvIds, idParam, isoDate } from '../lib/http';
import { localDate } from '../lib/time';
import { vacationDays } from '../services/approvals';
import { notifyEmployee } from '../services/planning/ops';
import { remainingDays } from '../services/vacation';
import { requireFeature } from '../services/features';
import { carryOver, sendNotices } from '../services/vacationJobs';
import type { Db, Trx } from '../db';
import type { Principal } from '../lib/scope';

const planners = requireRole('superAdmin', 'admin', 'manager');
const admins = requireRole('superAdmin', 'admin');
const EM = requireRole('employee');

export async function leaveRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);
  const tzOf = async (d: Db | Trx, hotelId: number) =>
    (await d.selectFrom('hotel').select('timezone').where('id', '=', hotelId).executeTakeFirstOrThrow())
      .timezone;
  const myEmployee = async (d: Db | Trx, p: Principal) => {
    if (!p.employeeId) throw new AppError('FORBIDDEN_SCOPE', 'No employee role selected');
    return d
      .selectFrom('employee')
      .selectAll()
      .where('employee_id', '=', p.employeeId)
      .executeTakeFirstOrThrow();
  };

  // ------------------------------------------------------------------ blackout periods
  const blackoutBody = z
    .object({
      hotelId: z.number().int().positive(),
      departmentId: z.number().int().positive().nullish(),
      from: isoDate,
      to: isoDate,
      reason: z.string().max(200).nullish(),
      /** null = no vacation allowed at all */
      maxConcurrentAbsent: z.number().int().min(0).max(500).nullish(),
    })
    .refine((b) => b.to >= b.from, 'to must not be before from');
  const blackoutOut = (b: Selectable<DB['absence_blackout']>): BlackoutDto => ({
    id: b.id,
    hotelId: b.hotel_id,
    departmentId: b.department_id,
    from: b.from_date,
    to: b.to_date,
    reason: b.reason,
    maxConcurrentAbsent: b.max_concurrent_absent,
  });
  const checkDept = async (trx: Db | Trx, hotelId: number, departmentId?: number | null) => {
    if (!departmentId) return;
    const d = await trx
      .selectFrom('department')
      .select('hotel_id')
      .where('id', '=', departmentId)
      .executeTakeFirst();
    if (!d || d.hotel_id !== hotelId)
      throw new AppError('VALIDATION', 'The department does not belong to this hotel');
  };

  r.get(
    '/blackouts',
    {
      preValidation: planners,
      schema: {
        querystring: z.object({ hotelIds: csvIds, from: isoDate.optional(), to: isoDate.optional() }),
      },
    },
    async (req) => {
      const hotels = getPrincipal(req).scope.hotels(req.query.hotelIds);
      if (!hotels.length) return { items: [] };
      let qb = db
        .selectFrom('absence_blackout')
        .selectAll()
        .where('hotel_id', 'in', hotels)
        .orderBy('from_date');
      if (req.query.from) qb = qb.where('to_date', '>=', req.query.from);
      if (req.query.to) qb = qb.where('from_date', '<=', req.query.to);
      return { items: (await qb.execute()).map(blackoutOut) };
    },
  );

  r.post('/blackouts', { preValidation: planners, schema: { body: blackoutBody } }, async (req, reply) => {
    const p = getPrincipal(req);
    const b = req.body;
    p.scope.assertHotel(b.hotelId);
    const row = await tx(async (trx) => {
      await checkDept(trx, b.hotelId, b.departmentId);
      const x = await trx
        .insertInto('absence_blackout')
        .values({
          hotel_id: b.hotelId,
          department_id: b.departmentId ?? null,
          from_date: b.from,
          to_date: b.to,
          reason: b.reason ?? null,
          max_concurrent_absent: b.maxConcurrentAbsent ?? null,
          created_by_user_id: p.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), {
        action: 'blackout_created',
        entityType: 'absence_blackout',
        entityId: x.id,
        hotelId: b.hotelId,
        new: blackoutOut(x),
      });
      return x;
    });
    return reply.status(201).send(blackoutOut(row));
  });

  r.put(
    '/blackouts/:id',
    { preValidation: planners, schema: { params: idParam, body: blackoutBody } },
    async (req) => {
      const p = getPrincipal(req);
      const b = req.body;
      return tx(async (trx) => {
        const old = await trx
          .selectFrom('absence_blackout')
          .selectAll()
          .where('id', '=', req.params.id)
          .executeTakeFirst();
        if (!old) throw notFound('Blackout');
        p.scope.assertHotel(old.hotel_id);
        p.scope.assertHotel(b.hotelId);
        await checkDept(trx, b.hotelId, b.departmentId);
        const x = await trx
          .updateTable('absence_blackout')
          .set({
            hotel_id: b.hotelId,
            department_id: b.departmentId ?? null,
            from_date: b.from,
            to_date: b.to,
            reason: b.reason ?? null,
            max_concurrent_absent: b.maxConcurrentAbsent ?? null,
          })
          .where('id', '=', old.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'blackout_updated',
          entityType: 'absence_blackout',
          entityId: old.id,
          hotelId: b.hotelId,
          old: blackoutOut(old),
          new: blackoutOut(x),
        });
        return blackoutOut(x);
      });
    },
  );

  r.delete('/blackouts/:id', { preValidation: planners, schema: { params: idParam } }, async (req, reply) => {
    const p = getPrincipal(req);
    await tx(async (trx) => {
      const old = await trx
        .selectFrom('absence_blackout')
        .selectAll()
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!old) throw notFound('Blackout');
      p.scope.assertHotel(old.hotel_id);
      await trx.deleteFrom('absence_blackout').where('id', '=', old.id).execute();
      await audit(trx, actorOf(req), {
        action: 'blackout_deleted',
        entityType: 'absence_blackout',
        entityId: old.id,
        hotelId: old.hotel_id,
        old: blackoutOut(old),
      });
    });
    return reply.status(204).send();
  });

  r.get(
    '/me/blackouts',
    { preValidation: EM, schema: { querystring: z.object({ from: isoDate, to: isoDate }) } },
    async (req) => {
      const emp = await myEmployee(db, getPrincipal(req));
      const rows = await db
        .selectFrom('absence_blackout')
        .selectAll()
        .where('hotel_id', '=', emp.primary_hotel_id)
        .where('to_date', '>=', req.query.from)
        .where('from_date', '<=', req.query.to)
        .where((eb) =>
          eb.or([eb('department_id', 'is', null), eb('department_id', '=', emp.primary_department_id)]),
        )
        .orderBy('from_date')
        .execute();
      return { items: rows.map(blackoutOut) };
    },
  );

  // ------------------------------------------------------------------ vacation planner (Urlaub view)
  r.get(
    '/vacation/overview',
    {
      preValidation: planners,
      schema: {
        querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100), hotelIds: csvIds }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      const { year } = req.query;
      const hotels = p.scope.hotels(req.query.hotelIds);
      if (!hotels.length) return { year, employees: [] };
      const emps = await db
        .selectFrom('employee as e')
        .innerJoin('department as d', 'd.id', 'e.primary_department_id')
        .select([
          'e.employee_id',
          'e.display_name',
          'e.primary_hotel_id',
          'e.primary_department_id',
          'd.name as dept',
        ])
        .where('e.primary_hotel_id', 'in', hotels)
        .where('e.status', '=', 'active')
        .orderBy('e.last_name')
        .execute();
      const ids = emps.map((e) => e.employee_id);
      const allow = ids.length
        ? await db
            .selectFrom('employee_vacation_allowance')
            .selectAll()
            .where('year', '=', year)
            .where('employee_id', 'in', ids)
            .execute()
        : [];
      const offs = ids.length
        ? await db
            .selectFrom('time_off')
            .selectAll()
            .where('employee_id', 'in', ids)
            .where('type', '=', 'annual_leave')
            .where('status', 'in', ['approved', 'pending'])
            .where('start_date', '<=', `${year}-12-31`)
            .where('end_date', '>=', `${year}-01-01`)
            .orderBy('start_date')
            .execute()
        : [];
      const today = localDate(app.clock(), await tzOf(db, hotels[0]!));
      const employees = [];
      for (const e of emps) {
        const a = allow.find((x) => x.employee_id === e.employee_id);
        const months = Array<number>(12).fill(0);
        let taken = 0;
        let planned = 0;
        let requested = 0;
        const entries = [];
        for (const t of offs.filter((x) => x.employee_id === e.employee_id)) {
          const days = (await vacationDays(db, e.employee_id, t.start_date, t.end_date)).filter((d) =>
            d.startsWith(String(year)),
          );
          const w = t.half_day ? 0.5 : 1;
          for (const d of days) {
            if (t.status === 'approved') months[Number(d.slice(5, 7)) - 1]! += w;
            if (t.status === 'pending') requested += w;
            else if (d < today) taken += w;
            else planned += w;
          }
          entries.push({
            id: t.id,
            from: t.start_date,
            to: t.end_date,
            days: t.time_off_days,
            halfDay: t.half_day,
            status: t.status,
          });
        }
        employees.push({
          employeeId: e.employee_id,
          displayName: e.display_name,
          hotelId: e.primary_hotel_id,
          departmentId: e.primary_department_id,
          departmentName: e.dept,
          entitlement: a?.allocated_days ?? null,
          carryover: a ? a.carried_statutory_days + a.carried_contractual_days : 0,
          carryoverExpiresOn: a?.carryover_expires_on ?? null,
          taken,
          planned,
          requested,
          remaining: a ? remainingDays(a) : null,
          months,
          entries,
        });
      }
      return { year, today, employees };
    },
  );

  r.get('/me/shifts', { preValidation: EM }, async (req) => {
    const emp = await myEmployee(db, getPrincipal(req));
    const rows = await db
      .selectFrom('shift as s')
      .innerJoin('hotel as h', 'h.id', 's.hotel_id')
      .select(['s.id', 's.name', 's.start_time', 's.end_time', 'h.name as hotel_name'])
      .where('s.hotel_id', 'in', (eb) =>
        eb.selectFrom('employee_hotel').select('hotel_id').where('employee_id', '=', emp.employee_id),
      )
      .orderBy('s.hotel_id')
      .orderBy('s.start_time')
      .execute();
    return {
      items: rows.map((s) => ({
        id: s.id,
        name: s.name,
        startTime: String(s.start_time).slice(0, 5),
        endTime: String(s.end_time).slice(0, 5),
        hotelName: s.hotel_name,
      })),
    };
  });

  // ------------------------------------------------------------------ wishes (employee)
  const priority = z.number().int().min(1).max(3);
  const shiftWishOut = (
    w: Pick<
      Selectable<DB['employee_shift_wish']>,
      'id' | 'date' | 'shift_id' | 'hotel_id' | 'priority' | 'reason' | 'status' | 'decision_note'
    >,
  ): ShiftWishDto => ({
    id: w.id,
    date: w.date,
    shiftId: w.shift_id,
    hotelId: w.hotel_id,
    priority: w.priority,
    reason: w.reason,
    status: w.status,
    decisionNote: w.decision_note,
  });
  const leaveWishOut = (
    w: Pick<
      Selectable<DB['employee_leave_wish']>,
      'id' | 'start_date' | 'end_date' | 'leave_days' | 'priority' | 'reason' | 'status' | 'decision_note'
    >,
  ): LeaveWishDto => ({
    id: w.id,
    from: w.start_date,
    to: w.end_date,
    days: w.leave_days,
    priority: w.priority,
    reason: w.reason,
    status: w.status,
    decisionNote: w.decision_note,
  });

  const wishFeature = requireFeature(db, 'wishes');
  r.post(
    '/me/shift-wishes',
    {
      preValidation: EM,
      preHandler: wishFeature,
      schema: {
        body: z.object({
          date: isoDate,
          shiftId: z.number().int().positive(),
          priority,
          reason: z.string().max(300).optional(),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const b = req.body;
      const row = await tx(async (trx) => {
        const emp = await myEmployee(trx, p);
        const shift = await trx
          .selectFrom('shift')
          .select(['id', 'hotel_id'])
          .where('id', '=', b.shiftId)
          .executeTakeFirst();
        const hs = await trx
          .selectFrom('employee_hotel')
          .select('hotel_id')
          .where('employee_id', '=', emp.employee_id)
          .execute();
        if (!shift || !hs.some((h) => h.hotel_id === shift.hotel_id))
          throw new AppError('VALIDATION', 'Unknown shift');
        const today = localDate(app.clock(), await tzOf(trx, shift.hotel_id));
        if (b.date < today) throw new AppError('VALIDATION', 'Wishes cannot be for past days');
        const dup = await trx
          .selectFrom('employee_shift_wish')
          .select('id')
          .where('employee_id', '=', emp.employee_id)
          .where('date', '=', b.date)
          .where('shift_id', '=', b.shiftId)
          .where('status', 'in', ['pending', 'granted'])
          .executeTakeFirst();
        if (dup)
          throw new AppError('CONFLICT', 'There is already a wish for this shift and day', {
            wishId: dup.id,
          });
        const w = await trx
          .insertInto('employee_shift_wish')
          .values({
            employee_id: emp.employee_id,
            hotel_id: shift.hotel_id,
            date: b.date,
            shift_id: b.shiftId,
            priority: b.priority,
            reason: b.reason ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'shift_wish_created',
          entityType: 'employee_shift_wish',
          entityId: w.id,
          hotelId: shift.hotel_id,
          companyId: emp.company_id,
          new: { date: b.date, shiftId: b.shiftId },
        });
        return w;
      });
      return reply.status(201).send(shiftWishOut(row));
    },
  );
  r.get('/me/shift-wishes', { preValidation: EM }, async (req) => {
    const emp = await myEmployee(db, getPrincipal(req));
    const rows = await db
      .selectFrom('employee_shift_wish')
      .selectAll()
      .where('employee_id', '=', emp.employee_id)
      .orderBy('date', 'desc')
      .limit(200)
      .execute();
    return { items: rows.map(shiftWishOut) };
  });

  r.post(
    '/me/leave-wishes',
    {
      preValidation: EM,
      preHandler: wishFeature,
      schema: {
        body: z.object({ from: isoDate, to: isoDate, priority, reason: z.string().max(300).optional() }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const b = req.body;
      const row = await tx(async (trx) => {
        const emp = await myEmployee(trx, p);
        if (b.to < b.from) throw new AppError('VALIDATION', 'to must not be before from');
        const today = localDate(app.clock(), await tzOf(trx, emp.primary_hotel_id));
        if (b.from < today) throw new AppError('VALIDATION', 'Wishes cannot start in the past');
        const days = await vacationDays(trx, emp.employee_id, b.from, b.to);
        if (!days.length) throw new AppError('VALIDATION', 'The range contains no working days');
        const w = await trx
          .insertInto('employee_leave_wish')
          .values({
            employee_id: emp.employee_id,
            hotel_id: emp.primary_hotel_id,
            start_date: b.from,
            end_date: b.to,
            leave_days: days.length,
            priority: b.priority,
            reason: b.reason ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'leave_wish_created',
          entityType: 'employee_leave_wish',
          entityId: w.id,
          hotelId: emp.primary_hotel_id,
          companyId: emp.company_id,
          new: { from: b.from, to: b.to },
        });
        return w;
      });
      return reply.status(201).send(leaveWishOut(row));
    },
  );
  r.get('/me/leave-wishes', { preValidation: EM }, async (req) => {
    const emp = await myEmployee(db, getPrincipal(req));
    const rows = await db
      .selectFrom('employee_leave_wish')
      .selectAll()
      .where('employee_id', '=', emp.employee_id)
      .orderBy('start_date', 'desc')
      .limit(200)
      .execute();
    return { items: rows.map(leaveWishOut) };
  });

  for (const kind of ['shift', 'leave'] as const) {
    const table = kind === 'shift' ? 'employee_shift_wish' : 'employee_leave_wish';
    r.delete(`/me/${kind}-wishes/:id`, { preValidation: EM, schema: { params: idParam } }, async (req) => {
      const p = getPrincipal(req);
      return tx(async (trx) => {
        const emp = await myEmployee(trx, p);
        const w = await trx
          .selectFrom(table)
          .selectAll()
          .where('id', '=', req.params.id)
          .where('employee_id', '=', emp.employee_id)
          .forUpdate()
          .executeTakeFirst();
        if (!w) throw notFound('Wish');
        if (w.status !== 'pending') throw new AppError('CONFLICT', 'Only open wishes can be withdrawn');
        await trx
          .updateTable(table)
          .set({ status: 'withdrawn', updated_at: app.clock() })
          .where('id', '=', w.id)
          .execute();
        await audit(trx, actorOf(req), {
          action: `${kind}_wish_withdrawn`,
          entityType: table,
          entityId: w.id,
          hotelId: w.hotel_id,
          companyId: emp.company_id,
        });
        return { id: w.id, status: 'withdrawn' };
      });
    });
  }

  // ------------------------------------------------------------------ wishes (planners)
  r.get(
    '/wishes',
    {
      preValidation: planners,
      schema: {
        querystring: z.object({
          hotelIds: csvIds,
          type: z.enum(['shift', 'leave']).default('leave'),
          status: z.enum(['pending', 'granted', 'declined', 'withdrawn']).optional(),
          from: isoDate.optional(),
          to: isoDate.optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const hotels = getPrincipal(req).scope.hotels(q.hotelIds);
      if (!hotels.length) return { items: [] };
      if (q.type === 'shift') {
        let qb = db
          .selectFrom('employee_shift_wish as w')
          .innerJoin('employee as e', 'e.employee_id', 'w.employee_id')
          .innerJoin('shift as s', 's.id', 'w.shift_id')
          .select([
            'w.id',
            'w.employee_id',
            'w.hotel_id',
            'w.date',
            'w.shift_id',
            'w.priority',
            'w.reason',
            'w.status',
            'w.decision_note',
            'e.display_name',
            's.name as shift_name',
          ])
          .where('w.hotel_id', 'in', hotels)
          .orderBy('w.date')
          .limit(500);
        if (q.status) qb = qb.where('w.status', '=', q.status);
        if (q.from) qb = qb.where('w.date', '>=', q.from);
        if (q.to) qb = qb.where('w.date', '<=', q.to);
        return {
          items: (await qb.execute()).map((w) => ({
            ...shiftWishOut(w),
            type: 'shift',
            employeeId: w.employee_id,
            displayName: w.display_name,
            shiftName: w.shift_name,
          })),
        };
      }
      let qb = db
        .selectFrom('employee_leave_wish as w')
        .innerJoin('employee as e', 'e.employee_id', 'w.employee_id')
        .select([
          'w.id',
          'w.employee_id',
          'w.hotel_id',
          'w.start_date',
          'w.end_date',
          'w.leave_days',
          'w.priority',
          'w.reason',
          'w.status',
          'w.decision_note',
          'e.display_name',
        ])
        .where('w.hotel_id', 'in', hotels)
        .orderBy('w.start_date')
        .limit(500);
      if (q.status) qb = qb.where('w.status', '=', q.status);
      if (q.from) qb = qb.where('w.end_date', '>=', q.from);
      if (q.to) qb = qb.where('w.start_date', '<=', q.to);
      return {
        items: (await qb.execute()).map((w) => ({
          ...leaveWishOut(w),
          type: 'leave',
          employeeId: w.employee_id,
          displayName: w.display_name,
        })),
      };
    },
  );

  for (const kind of ['shift', 'leave'] as const) {
    const table = kind === 'shift' ? 'employee_shift_wish' : 'employee_leave_wish';
    r.put(
      `/wishes/${kind}/:id`,
      {
        preValidation: planners,
        schema: {
          params: idParam,
          body: z.object({ decision: z.enum(['grant', 'decline']), note: z.string().max(300).optional() }),
        },
      },
      async (req) => {
        const p = getPrincipal(req);
        return tx(async (trx) => {
          const w = await trx
            .selectFrom(table)
            .selectAll()
            .where('id', '=', req.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (!w) throw notFound('Wish');
          p.scope.assertHotel(w.hotel_id);
          if (w.status !== 'pending') throw new AppError('CONFLICT', 'The wish was already decided');
          const emp = await trx
            .selectFrom('employee')
            .select(['employee_id', 'user_id', 'company_id'])
            .where('employee_id', '=', w.employee_id)
            .executeTakeFirstOrThrow();
          if (emp.user_id === p.userId)
            throw new AppError('SELF_APPROVAL', 'You cannot decide on your own wishes');
          const status = req.body.decision === 'grant' ? 'granted' : 'declined';
          const now = app.clock();
          await trx
            .updateTable(table)
            .set({
              status,
              decided_by_user_id: p.userId,
              decided_at: now,
              decision_note: req.body.note ?? null,
              updated_at: now,
            })
            .where('id', '=', w.id)
            .execute();
          await notifyEmployee(trx, { id: emp.employee_id, userId: emp.user_id }, 'wish_decision', {
            kind,
            wishId: w.id,
            decision: status,
            note: req.body.note ?? null,
          });
          await audit(trx, actorOf(req), {
            action: `${kind}_wish_${status}`,
            entityType: table,
            entityId: w.id,
            hotelId: w.hotel_id,
            companyId: emp.company_id,
            reason: req.body.note ?? null,
          });
          return { id: w.id, status };
        });
      },
    );
  }

  // ------------------------------------------------------------------ carryover and vacation notices
  r.post(
    '/vacation/carryover',
    { preValidation: admins, schema: { body: z.object({ year: z.number().int().min(2000).max(2100) }) } },
    async (req) => {
      const p = getPrincipal(req);
      return tx(async (trx) => {
        const res = await carryOver(trx, req.body.year, { companyIds: p.scope.companyIds }, actorOf(req));
        await audit(trx, actorOf(req), {
          action: 'vacation_carryover_run',
          entityType: 'company',
          new: { year: req.body.year, ...res },
        });
        return res;
      });
    },
  );

  r.post(
    '/vacation/notices/send',
    {
      preValidation: admins,
      schema: {
        body: z.object({
          year: z.number().int().min(2000).max(2100),
          kind: z.enum(['initial', 'reminder', 'final']),
          employeeIds: z.array(z.number().int().positive()).optional(),
        }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      return tx(async (trx) => {
        const res = await sendNotices(trx, req.body.year, req.body.kind, {
          companyIds: p.scope.companyIds,
          employeeIds: req.body.employeeIds,
        });
        await audit(trx, actorOf(req), {
          action: 'vacation_notices_sent',
          entityType: 'company',
          new: { year: req.body.year, kind: req.body.kind, ...res },
        });
        return res;
      });
    },
  );

  r.get(
    '/vacation/notices',
    {
      preValidation: planners,
      schema: { querystring: z.object({ year: z.coerce.number().int(), hotelIds: csvIds }) },
    },
    async (req) => {
      const hotels = getPrincipal(req).scope.hotels(req.query.hotelIds);
      if (!hotels.length) return { items: [] };
      const rows = await db
        .selectFrom('vacation_notice as n')
        .innerJoin('employee as e', 'e.employee_id', 'n.employee_id')
        .select([
          'n.id',
          'n.employee_id',
          'n.kind',
          'n.remaining_days',
          'n.channel',
          'n.sent_at',
          'n.acknowledged_at',
          'e.display_name',
        ])
        .where('n.year', '=', req.query.year)
        .where('e.primary_hotel_id', 'in', hotels)
        .orderBy('n.id', 'desc')
        .execute();
      return {
        items: rows.map((n) => ({
          id: n.id,
          employeeId: n.employee_id,
          displayName: n.display_name,
          kind: n.kind,
          remainingDays: n.remaining_days,
          channel: n.channel,
          sentAt: n.sent_at.toISOString(),
          acknowledgedAt: n.acknowledged_at?.toISOString() ?? null,
        })),
      };
    },
  );

  r.get('/me/vacation-notices', { preValidation: EM }, async (req) => {
    const emp = await myEmployee(db, getPrincipal(req));
    const rows = await db
      .selectFrom('vacation_notice')
      .selectAll()
      .where('employee_id', '=', emp.employee_id)
      .orderBy('id', 'desc')
      .limit(50)
      .execute();
    return {
      items: rows.map((n) => ({
        id: n.id,
        year: n.year,
        kind: n.kind,
        remainingDays: n.remaining_days,
        sentAt: n.sent_at.toISOString(),
        acknowledgedAt: n.acknowledged_at?.toISOString() ?? null,
      })),
    };
  });
  r.put('/me/vacation-notices/:id/ack', { preValidation: EM, schema: { params: idParam } }, async (req) => {
    const emp = await myEmployee(db, getPrincipal(req));
    const n = await db
      .updateTable('vacation_notice')
      .set({ acknowledged_at: app.clock() })
      .where('id', '=', req.params.id)
      .where('employee_id', '=', emp.employee_id)
      .where('acknowledged_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!n) throw notFound('Notice');
    return { id: n.id, acknowledged: true };
  });
}
