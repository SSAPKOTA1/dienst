import type { OpenShiftDto } from '@dienst/shared';
import type { DB } from '../db';
import type { Selectable } from 'kysely';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { csvIds, hhmm, idParam, isoDate } from '../lib/http';
import { localDate, zonedInstant } from '../lib/time';
import { addDays } from '@dienst/rules';
import { requireFeature } from '../services/features';
import { blocking, myEmployee, notifyEmp, notifyPlanners, slotViolations } from '../services/collab';
import { runOp } from '../services/planning/run';
import type { Trx } from '../db';

const planners = requireRole('superAdmin', 'admin', 'manager');
const EM = requireRole('employee');

export async function openShiftRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);
  const openOn = requireFeature(db, 'open_shifts');
  // ------------------------------------------------------------------ open shifts
  const openOut = (o: Selectable<DB['open_shift']>): OpenShiftDto => ({
    id: o.id,
    hotelId: o.hotel_id,
    departmentId: o.department_id,
    shiftId: o.shift_id,
    date: o.shift_date,
    start: o.planned_start.toISOString(),
    end: o.planned_end.toISOString(),
    breakMinutes: o.planned_break_minutes,
    status: o.status,
  });

  r.post(
    '/open-shifts',
    {
      preValidation: planners,
      schema: {
        body: z.object({
          hotelId: z.number().int().positive(),
          departmentId: z.number().int().positive(),
          shiftId: z.number().int().positive().optional(),
          date: isoDate,
          start: hhmm.optional(),
          end: hhmm.optional(),
          breakMinutes: z.number().int().min(0).max(240).optional(),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const b = req.body;
      p.scope.assertHotel(b.hotelId);
      const row = await tx(async (trx) => {
        const dept = await trx
          .selectFrom('department')
          .select('hotel_id')
          .where('id', '=', b.departmentId)
          .executeTakeFirst();
        if (!dept || dept.hotel_id !== b.hotelId)
          throw new AppError('VALIDATION', 'The department does not belong to this hotel');
        const tz = (
          await trx
            .selectFrom('hotel')
            .select('timezone')
            .where('id', '=', b.hotelId)
            .executeTakeFirstOrThrow()
        ).timezone;
        let start = b.start;
        let end = b.end;
        let brk = b.breakMinutes;
        if (b.shiftId) {
          const sh = await trx.selectFrom('shift').selectAll().where('id', '=', b.shiftId).executeTakeFirst();
          if (!sh || sh.hotel_id !== b.hotelId || sh.department_id !== b.departmentId)
            throw new AppError('VALIDATION', 'Unknown shift');
          start ??= String(sh.start_time).slice(0, 5);
          end ??= String(sh.end_time).slice(0, 5);
          brk ??= sh.break_duration_minutes;
        }
        if (!start || !end) throw new AppError('VALIDATION', 'Pick a shift or give start and end');
        const s = zonedInstant(b.date, start, tz);
        let e = zonedInstant(b.date, end, tz);
        if (e <= s) e = zonedInstant(addDays(b.date, 1), end, tz);
        if (localDate(app.clock(), tz) > b.date) throw new AppError('VALIDATION', 'The date is in the past');
        const o = await trx
          .insertInto('open_shift')
          .values({
            hotel_id: b.hotelId,
            department_id: b.departmentId,
            shift_id: b.shiftId ?? null,
            shift_date: b.date,
            planned_start: s,
            planned_end: e,
            planned_break_minutes: brk ?? 0,
            created_by_user_id: p.userId,
            created_by_role: p.role === 'superAdmin' ? 'super_admin' : p.role,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'open_shift_created',
          entityType: 'open_shift',
          entityId: o.id,
          hotelId: b.hotelId,
          new: openOut(o),
        });
        return o;
      });
      return reply.status(201).send(openOut(row));
    },
  );

  r.get(
    '/open-shifts',
    {
      preValidation: planners,
      schema: {
        querystring: z.object({
          hotelIds: csvIds,
          status: z.enum(['open', 'filled', 'cancelled']).default('open'),
        }),
      },
    },
    async (req) => {
      const hotels = getPrincipal(req).scope.hotels(req.query.hotelIds);
      if (!hotels.length) return { items: [] };
      const rows = await db
        .selectFrom('open_shift')
        .selectAll()
        .where('hotel_id', 'in', hotels)
        .where('status', '=', req.query.status)
        .orderBy('shift_date')
        .execute();
      const items = [];
      for (const o of rows) {
        const claims = await db
          .selectFrom('open_shift_claim as c')
          .innerJoin('employee as e', 'e.employee_id', 'c.employee_id')
          .select(['c.id', 'c.employee_id', 'c.status', 'e.display_name'])
          .where('c.open_shift_id', '=', o.id)
          .orderBy('c.id')
          .execute();
        items.push({
          ...openOut(o),
          claims: claims.map((c) => ({
            id: c.id,
            employeeId: c.employee_id,
            displayName: c.display_name,
            status: c.status,
          })),
        });
      }
      return { items };
    },
  );

  r.delete('/open-shifts/:id', { preValidation: planners, schema: { params: idParam } }, async (req) => {
    const p = getPrincipal(req);
    return tx(async (trx) => {
      const o = await trx
        .selectFrom('open_shift')
        .selectAll()
        .where('id', '=', req.params.id)
        .forUpdate()
        .executeTakeFirst();
      if (!o) throw notFound('Open shift');
      p.scope.assertHotel(o.hotel_id);
      if (o.status !== 'open') throw new AppError('CONFLICT', 'The open shift is already closed');
      await trx.updateTable('open_shift').set({ status: 'cancelled' }).where('id', '=', o.id).execute();
      await trx
        .updateTable('open_shift_claim')
        .set({ status: 'rejected' })
        .where('open_shift_id', '=', o.id)
        .where('status', '=', 'pending')
        .execute();
      await audit(trx, actorOf(req), {
        action: 'open_shift_cancelled',
        entityType: 'open_shift',
        entityId: o.id,
        hotelId: o.hotel_id,
      });
      return { id: o.id, status: 'cancelled' };
    });
  });

  r.get('/me/open-shifts', { preValidation: EM, preHandler: openOn }, async (req) => {
    const me = await myEmployee(db, getPrincipal(req));
    const now = app.clock();
    const depts = await db
      .selectFrom('employee_department')
      .select('department_id')
      .where('employee_id', '=', me.employee_id)
      .execute();
    const hotels = await db
      .selectFrom('employee_hotel')
      .select('hotel_id')
      .where('employee_id', '=', me.employee_id)
      .execute();
    if (!depts.length || !hotels.length) return { items: [] };
    const rows = await db
      .selectFrom('open_shift')
      .selectAll()
      .where('status', '=', 'open')
      .where('planned_start', '>', now)
      .where(
        'department_id',
        'in',
        depts.map((d) => d.department_id),
      )
      .where(
        'hotel_id',
        'in',
        hotels.map((h) => h.hotel_id),
      )
      .orderBy('shift_date')
      .execute();
    const items = [];
    for (const o of rows) {
      const v = await slotViolations(db, now, me.employee_id, {
        hotelId: o.hotel_id,
        departmentId: o.department_id,
        shiftId: o.shift_id,
        date: o.shift_date,
        startMs: o.planned_start.getTime(),
        endMs: o.planned_end.getTime(),
        breakMinutes: o.planned_break_minutes,
      });
      if (blocking(v).length) continue; // only slots the person may actually work
      const claim = await db
        .selectFrom('open_shift_claim')
        .select(['id', 'status'])
        .where('open_shift_id', '=', o.id)
        .where('employee_id', '=', me.employee_id)
        .executeTakeFirst();
      const shift = o.shift_id
        ? await db.selectFrom('shift').select('name').where('id', '=', o.shift_id).executeTakeFirst()
        : null;
      items.push({
        ...openOut(o),
        shiftName: shift?.name ?? null,
        warnings: v.filter((x) => x.severity !== 'block').map((x) => x.code),
        claim: claim ? { id: claim.id, status: claim.status } : null,
      });
    }
    return { items };
  });

  r.post(
    '/me/open-shifts/:id/claim',
    { preValidation: EM, preHandler: openOn, schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      const out = await tx(async (trx) => {
        const me = await myEmployee(trx, p);
        const now = app.clock();
        const o = await trx
          .selectFrom('open_shift')
          .selectAll()
          .where('id', '=', req.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!o || o.status !== 'open' || o.planned_start <= now) throw notFound('Open shift');
        const inDept = await trx
          .selectFrom('employee_department')
          .select('department_id')
          .where('employee_id', '=', me.employee_id)
          .where('department_id', '=', o.department_id)
          .executeTakeFirst();
        const inHotel = await trx
          .selectFrom('employee_hotel')
          .select('hotel_id')
          .where('employee_id', '=', me.employee_id)
          .where('hotel_id', '=', o.hotel_id)
          .executeTakeFirst();
        if (!inDept || !inHotel) throw notFound('Open shift');
        const bad = blocking(
          await slotViolations(trx, now, me.employee_id, {
            hotelId: o.hotel_id,
            departmentId: o.department_id,
            shiftId: o.shift_id,
            date: o.shift_date,
            startMs: o.planned_start.getTime(),
            endMs: o.planned_end.getTime(),
            breakMinutes: o.planned_break_minutes,
          }),
        );
        if (bad.length) throw new AppError('RULE_BLOCKED', 'You cannot work this shift', { violations: bad });
        const existing = await trx
          .selectFrom('open_shift_claim')
          .select(['id', 'status'])
          .where('open_shift_id', '=', o.id)
          .where('employee_id', '=', me.employee_id)
          .executeTakeFirst();
        if (existing && existing.status !== 'withdrawn')
          throw new AppError('CONFLICT', 'You already applied');
        const c = existing
          ? await trx
              .updateTable('open_shift_claim')
              .set({ status: 'pending' })
              .where('id', '=', existing.id)
              .returning('id')
              .executeTakeFirstOrThrow()
          : await trx
              .insertInto('open_shift_claim')
              .values({ open_shift_id: o.id, employee_id: me.employee_id })
              .returning('id')
              .executeTakeFirstOrThrow();
        await notifyPlanners(trx, o.hotel_id, 'open_shift_claimed', {
          openShiftId: o.id,
          claimId: c.id,
          employeeId: me.employee_id,
        });
        await audit(trx, actorOf(req), {
          action: 'open_shift_claimed',
          entityType: 'open_shift',
          entityId: o.id,
          hotelId: o.hotel_id,
          companyId: me.company_id,
        });
        return c;
      });
      return reply.status(201).send({ id: out.id, status: 'pending' });
    },
  );

  r.delete(
    '/me/open-shifts/:id/claim',
    { preValidation: EM, preHandler: openOn, schema: { params: idParam } },
    async (req) => {
      const me = await myEmployee(db, getPrincipal(req));
      const c = await db
        .updateTable('open_shift_claim')
        .set({ status: 'withdrawn' })
        .where('open_shift_id', '=', req.params.id)
        .where('employee_id', '=', me.employee_id)
        .where('status', '=', 'pending')
        .returning('id')
        .executeTakeFirst();
      if (!c) throw notFound('Application');
      return { id: c.id, status: 'withdrawn' };
    },
  );

  r.put(
    '/open-shifts/claims/:id',
    {
      preValidation: planners,
      schema: {
        params: idParam,
        body: z.object({
          decision: z.enum(['approve', 'reject']),
          overrideReason: z.string().min(5).max(300).optional(),
        }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      return tx(async (trx) => {
        const c = await trx
          .selectFrom('open_shift_claim')
          .selectAll()
          .where('id', '=', req.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!c) throw notFound('Application');
        const o = await trx
          .selectFrom('open_shift')
          .selectAll()
          .where('id', '=', c.open_shift_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        p.scope.assertHotel(o.hotel_id);
        if (c.status !== 'pending' || o.status !== 'open')
          throw new AppError('CONFLICT', 'The application was already decided');
        const emp = await trx
          .selectFrom('employee')
          .select(['employee_id', 'user_id', 'company_id'])
          .where('employee_id', '=', c.employee_id)
          .executeTakeFirstOrThrow();
        if (emp.user_id === p.userId)
          throw new AppError('SELF_APPROVAL', 'You cannot decide on your own application');
        const now = app.clock();
        if (req.body.decision === 'reject') {
          await trx
            .updateTable('open_shift_claim')
            .set({ status: 'rejected', decided_by_user_id: p.userId })
            .where('id', '=', c.id)
            .execute();
          await notifyEmp(trx, emp.employee_id, 'open_shift_decision', {
            openShiftId: o.id,
            decision: 'rejected',
          });
          await audit(trx, actorOf(req), {
            action: 'open_shift_claim_rejected',
            entityType: 'open_shift',
            entityId: o.id,
            hotelId: o.hotel_id,
          });
          return { id: c.id, status: 'rejected' };
        }
        const tz = (
          await trx
            .selectFrom('hotel')
            .select('timezone')
            .where('id', '=', o.hotel_id)
            .executeTakeFirstOrThrow()
        ).timezone;
        const hhmmOf = (d: Date) =>
          new Intl.DateTimeFormat('en-GB', {
            timeZone: tz,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }).format(d);
        const res = (await runOp(
          { trx, principal: p, actor: actorOf(req), now },
          {
            op: 'create',
            hotelId: o.hotel_id,
            employeeId: c.employee_id,
            shiftId: o.shift_id ?? undefined,
            date: o.shift_date,
            start: hhmmOf(o.planned_start),
            end: hhmmOf(o.planned_end),
            plannedBreakMinutes: o.planned_break_minutes,
            overrideReason: req.body.overrideReason,
          },
        )) as { entry?: { id: number } };
        await trx
          .updateTable('open_shift')
          .set({ status: 'filled', filled_schedule_id: res.entry?.id ?? null })
          .where('id', '=', o.id)
          .execute();
        await trx
          .updateTable('open_shift_claim')
          .set({ status: 'approved', decided_by_user_id: p.userId })
          .where('id', '=', c.id)
          .execute();
        const others = await trx
          .updateTable('open_shift_claim')
          .set({ status: 'rejected', decided_by_user_id: p.userId })
          .where('open_shift_id', '=', o.id)
          .where('id', '<>', c.id)
          .where('status', '=', 'pending')
          .returning('employee_id')
          .execute();
        await notifyEmp(trx, emp.employee_id, 'open_shift_decision', {
          openShiftId: o.id,
          decision: 'approved',
          date: o.shift_date,
        });
        for (const x of others)
          await notifyEmp(trx, x.employee_id, 'open_shift_decision', {
            openShiftId: o.id,
            decision: 'rejected',
          });
        await audit(trx, actorOf(req), {
          action: 'open_shift_filled',
          entityType: 'open_shift',
          entityId: o.id,
          hotelId: o.hotel_id,
          companyId: emp.company_id,
          new: { employeeId: c.employee_id, scheduleId: res.entry?.id ?? null },
        });
        return { id: c.id, status: 'approved', scheduleId: res.entry?.id ?? null };
      });
    },
  );
}
