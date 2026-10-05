import type { SwapDto } from '@dienst/shared';
import type { DB } from '../db';
import type { Selectable } from 'kysely';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { csvIds, idParam } from '../lib/http';
import { requireFeature } from '../services/features';
import {
  blocking,
  myEmployee,
  notifyEmp,
  notifyPlanners,
  swapViolations,
  systemPlanner,
} from '../services/collab';
import { runOp } from '../services/planning/run';
import type { Ctx } from '../services/planning/ops';
import type { Db, Trx } from '../db';

const planners = requireRole('superAdmin', 'admin', 'manager');
const EM = requireRole('employee');
const SWAP_HOURS = 48;
const MIN_NOTICE_HOURS = 12;

export async function swapRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);
  const swapsOn = requireFeature(db, 'swaps');
  const swapOut = (s: Selectable<DB['shift_swap_request']>): SwapDto => ({
    id: s.id,
    hotelId: s.hotel_id,
    scheduleId: s.schedule_id,
    requesterEmployeeId: s.requester_employee_id,
    counterpartEmployeeId: s.counterpart_employee_id,
    counterpartScheduleId: s.counterpart_schedule_id,
    status: s.status,
    reason: s.reason,
    decisionNote: s.decision_note,
    expiresAt: s.expires_at.toISOString(),
    createdAt: s.created_at?.toISOString() ?? null,
  });

  // the slot description shown to the people involved
  const slotOf = async (d: Db | Trx, id: number) => {
    const x = await d
      .selectFrom('schedule as s')
      .leftJoin('shift as sh', 'sh.id', 's.shift_id')
      .select([
        's.id',
        's.shift_date',
        's.planned_start',
        's.planned_end',
        's.employee_id',
        's.hotel_id',
        's.status',
        's.published_at',
        'sh.name as shift_name',
      ])
      .where('s.id', '=', id)
      .executeTakeFirst();
    return x
      ? {
          id: x.id,
          date: x.shift_date,
          start: x.planned_start.toISOString(),
          end: x.planned_end.toISOString(),
          shiftName: x.shift_name,
          employeeId: x.employee_id,
        }
      : null;
  };

  // colleagues of my hotels (names only) and their upcoming published shifts, for the swap dialog
  r.get('/me/colleagues', { preValidation: EM, preHandler: swapsOn }, async (req) => {
    const me = await myEmployee(db, getPrincipal(req));
    const rows = await db
      .selectFrom('employee as e')
      .innerJoin('department as d', 'd.id', 'e.primary_department_id')
      .select(['e.employee_id', 'e.display_name', 'd.name as dept'])
      .where('e.status', '=', 'active')
      .where('e.employee_id', '<>', me.employee_id)
      .where('e.employee_id', 'in', (q) =>
        q
          .selectFrom('employee_hotel')
          .select('employee_id')
          .where('hotel_id', 'in', (h) =>
            h.selectFrom('employee_hotel').select('hotel_id').where('employee_id', '=', me.employee_id),
          ),
      )
      .orderBy('e.last_name')
      .limit(300)
      .execute();
    return {
      items: rows.map((x) => ({
        employeeId: x.employee_id,
        displayName: x.display_name,
        departmentName: x.dept,
      })),
    };
  });

  r.get(
    '/me/colleagues/:id/shifts',
    { preValidation: EM, preHandler: swapsOn, schema: { params: idParam } },
    async (req) => {
      const me = await myEmployee(db, getPrincipal(req));
      const shared = await db
        .selectFrom('employee_hotel as a')
        .innerJoin('employee_hotel as b', 'b.hotel_id', 'a.hotel_id')
        .select('a.hotel_id')
        .where('a.employee_id', '=', me.employee_id)
        .where('b.employee_id', '=', req.params.id)
        .executeTakeFirst();
      if (!shared) throw notFound('Colleague');
      const rows = await db
        .selectFrom('schedule as s')
        .leftJoin('shift as sh', 'sh.id', 's.shift_id')
        .select(['s.id', 's.shift_date', 's.planned_start', 's.planned_end', 'sh.name as shift'])
        .where('s.employee_id', '=', req.params.id)
        .where('s.status', '=', 'published')
        .where('s.planned_start', '>', app.clock())
        .where('s.hotel_id', '=', shared.hotel_id)
        .orderBy('s.planned_start')
        .limit(40)
        .execute();
      return {
        items: rows.map((x) => ({
          id: x.id,
          date: x.shift_date,
          start: x.planned_start.toISOString(),
          end: x.planned_end.toISOString(),
          shiftName: x.shift,
        })),
      };
    },
  );

  // ------------------------------------------------------------------ employee: create, list, accept, decline, cancel
  r.post(
    '/me/swap-requests',
    {
      preValidation: EM,
      preHandler: swapsOn,
      schema: {
        body: z.object({
          scheduleId: z.number().int().positive(),
          counterpartEmployeeId: z.number().int().positive().optional(),
          counterpartScheduleId: z.number().int().positive().optional(),
          reason: z.string().max(300).optional(),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const b = req.body;
      const row = await tx(async (trx) => {
        const me = await myEmployee(trx, p);
        const now = app.clock();
        const mine = await trx
          .selectFrom('schedule')
          .selectAll()
          .where('id', '=', b.scheduleId)
          .where('employee_id', '=', me.employee_id)
          .executeTakeFirst();
        if (!mine) throw notFound('Shift');
        if (mine.status !== 'published')
          throw new AppError('CONFLICT', 'Only published shifts can be offered');
        const hoursLeft = (mine.planned_start.getTime() - now.getTime()) / 3600e3;
        if (hoursLeft < MIN_NOTICE_HOURS)
          throw new AppError(
            'CONFLICT',
            `Shifts starting in less than ${MIN_NOTICE_HOURS} hours cannot be offered`,
          );
        let counterpart = b.counterpartEmployeeId ?? null;
        if (b.counterpartScheduleId) {
          const other = await trx
            .selectFrom('schedule')
            .selectAll()
            .where('id', '=', b.counterpartScheduleId)
            .executeTakeFirst();
          if (!other || other.status !== 'published' || other.planned_start <= now)
            throw new AppError('VALIDATION', 'The other shift is not available');
          if (other.employee_id === me.employee_id)
            throw new AppError('VALIDATION', 'Pick a shift of a colleague');
          if (other.hotel_id !== mine.hotel_id)
            throw new AppError('VALIDATION', 'Swaps are within one hotel');
          counterpart = other.employee_id;
        }
        if (counterpart != null) {
          if (counterpart === me.employee_id) throw new AppError('VALIDATION', 'Pick a colleague');
          const c = await trx
            .selectFrom('employee')
            .select(['employee_id', 'company_id', 'status'])
            .where('employee_id', '=', counterpart)
            .executeTakeFirst();
          if (!c || c.company_id !== me.company_id || c.status !== 'active')
            throw new AppError('VALIDATION', 'Unknown colleague');
        }
        const dup = await trx
          .selectFrom('shift_swap_request')
          .select('id')
          .where('schedule_id', '=', b.scheduleId)
          .where('status', 'in', ['open', 'accepted_by_peer'])
          .executeTakeFirst();
        if (dup)
          throw new AppError('CONFLICT', 'There is already an open request for this shift', {
            requestId: dup.id,
          });
        // the receiving person must be able to work the shift (blocking rules only; reasons are for the approving planner)
        if (counterpart != null) {
          const bad = blocking(
            await swapViolations(trx, now, me.company_id, {
              scheduleId: b.scheduleId,
              counterpartEmployeeId: counterpart,
              counterpartScheduleId: b.counterpartScheduleId ?? null,
            }),
          );
          if (bad.length) throw new AppError('RULE_BLOCKED', 'The swap is not possible', { violations: bad });
        }
        const expires = new Date(
          Math.min(
            now.getTime() + SWAP_HOURS * 3600e3,
            mine.planned_start.getTime() - MIN_NOTICE_HOURS * 3600e3,
          ),
        );
        const s = await trx
          .insertInto('shift_swap_request')
          .values({
            hotel_id: mine.hotel_id,
            schedule_id: mine.id,
            requester_employee_id: me.employee_id,
            counterpart_employee_id: counterpart,
            counterpart_schedule_id: b.counterpartScheduleId ?? null,
            reason: b.reason ?? null,
            expires_at: expires,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        if (counterpart != null)
          await notifyEmp(trx, counterpart, 'swap_offered', { requestId: s.id, scheduleId: mine.id });
        await audit(trx, actorOf(req), {
          action: 'swap_requested',
          entityType: 'shift_swap_request',
          entityId: s.id,
          hotelId: mine.hotel_id,
          companyId: me.company_id,
          new: { scheduleId: mine.id, counterpart },
        });
        return s;
      });
      return reply.status(201).send(swapOut(row));
    },
  );

  r.get('/me/swap-requests', { preValidation: EM, preHandler: swapsOn }, async (req) => {
    const me = await myEmployee(db, getPrincipal(req));
    const now = app.clock();
    const rows = await db
      .selectFrom('shift_swap_request')
      .selectAll()
      .where('status', 'in', ['open', 'accepted_by_peer', 'approved', 'rejected', 'cancelled', 'expired'])
      .where((eb) =>
        eb.or([
          eb('requester_employee_id', '=', me.employee_id),
          eb('counterpart_employee_id', '=', me.employee_id),
          // giveaway to anyone: visible to colleagues of the same hotel and department while open
          eb.and([
            eb('counterpart_employee_id', 'is', null),
            eb('status', '=', 'open'),
            eb('expires_at', '>', now),
            eb('hotel_id', 'in', (q) =>
              q.selectFrom('employee_hotel').select('hotel_id').where('employee_id', '=', me.employee_id),
            ),
          ]),
        ]),
      )
      .orderBy('id', 'desc')
      .limit(100)
      .execute();
    const items = [];
    for (const s of rows) {
      const role =
        s.requester_employee_id === me.employee_id
          ? 'requester'
          : s.counterpart_employee_id === me.employee_id
            ? 'counterpart'
            : 'open';
      let eligible: boolean | null = null;
      if (role === 'open' && s.status === 'open') {
        eligible =
          blocking(
            await swapViolations(db, now, me.company_id, {
              scheduleId: s.schedule_id,
              counterpartEmployeeId: me.employee_id,
              counterpartScheduleId: null,
            }),
          ).length === 0;
        if (!eligible) continue; // never show shifts the person cannot take
      }
      items.push({
        ...swapOut(s),
        role,
        eligible,
        slot: await slotOf(db, s.schedule_id),
        counterpartSlot: s.counterpart_schedule_id ? await slotOf(db, s.counterpart_schedule_id) : null,
      });
    }
    return { items };
  });

  const decideAfterAccept = async (
    trx: Trx,
    req: FastifyRequest,
    s: Selectable<DB['shift_swap_request']>,
    companyId: number,
  ) => {
    const comp = await trx
      .selectFrom('company')
      .select('swap_approval')
      .where('id', '=', companyId)
      .executeTakeFirstOrThrow();
    await notifyPlanners(trx, s.hotel_id, 'swap_to_approve', { requestId: s.id });
    return comp.swap_approval;
  };

  r.put(
    '/me/swap-requests/:id/accept',
    { preValidation: EM, preHandler: swapsOn, schema: { params: idParam } },
    async (req) => {
      const p = getPrincipal(req);
      const result = await tx(async (trx) => {
        const me = await myEmployee(trx, p);
        const now = app.clock();
        const s = await trx
          .selectFrom('shift_swap_request')
          .selectAll()
          .where('id', '=', req.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!s) throw notFound('Request');
        if (s.status !== 'open' || s.expires_at <= now)
          throw new AppError('CONFLICT', 'The request is no longer open');
        if (s.requester_employee_id === me.employee_id)
          throw new AppError('VALIDATION', 'You cannot accept your own request');
        if (s.counterpart_employee_id != null && s.counterpart_employee_id !== me.employee_id)
          throw notFound('Request');
        if (s.counterpart_employee_id == null) {
          const hs = await trx
            .selectFrom('employee_hotel')
            .select('hotel_id')
            .where('employee_id', '=', me.employee_id)
            .where('hotel_id', '=', s.hotel_id)
            .executeTakeFirst();
          if (!hs) throw notFound('Request');
          const bad = blocking(
            await swapViolations(trx, now, me.company_id, {
              scheduleId: s.schedule_id,
              counterpartEmployeeId: me.employee_id,
              counterpartScheduleId: null,
            }),
          );
          if (bad.length)
            throw new AppError('RULE_BLOCKED', 'You cannot take this shift', { violations: bad });
        }
        await trx
          .updateTable('shift_swap_request')
          .set({ status: 'accepted_by_peer', counterpart_employee_id: me.employee_id })
          .where('id', '=', s.id)
          .execute();
        await notifyEmp(trx, s.requester_employee_id, 'swap_accepted', { requestId: s.id });
        await audit(trx, actorOf(req), {
          action: 'swap_accepted',
          entityType: 'shift_swap_request',
          entityId: s.id,
          hotelId: s.hotel_id,
          companyId: me.company_id,
        });
        const mode = await decideAfterAccept(trx, req, s, me.company_id);
        return { id: s.id, companyId: me.company_id, hotelId: s.hotel_id, mode };
      });
      // company setting: approve at once when the rule check passes, otherwise a planner decides
      let status = 'accepted_by_peer';
      if (result.mode === 'auto_if_valid') {
        try {
          await tx(async (trx) => {
            const s = await trx
              .selectFrom('shift_swap_request')
              .selectAll()
              .where('id', '=', result.id)
              .forUpdate()
              .executeTakeFirstOrThrow();
            const sys = await systemPlanner(trx, result.companyId, p.userId);
            const v = await swapViolations(trx, app.clock(), result.companyId, {
              scheduleId: s.schedule_id,
              counterpartEmployeeId: s.counterpart_employee_id,
              counterpartScheduleId: s.counterpart_schedule_id,
            });
            if (v.some((x) => x.severity !== 'warn')) throw new AppError('RULE_BLOCKED', 'Needs a planner');
            await applySwap(
              trx,
              { trx, principal: sys, actor: { ...actorOf(req), type: 'system' }, now: app.clock() },
              s,
              undefined,
            );
            await trx
              .updateTable('shift_swap_request')
              .set({
                status: 'approved',
                decided_at: app.clock(),
                decided_by_role: 'system',
                decision_note: 'auto_if_valid',
              })
              .where('id', '=', s.id)
              .execute();
          });
          status = 'approved';
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
        }
      }
      return { id: result.id, status };
    },
  );

  r.put(
    '/me/swap-requests/:id/decline',
    { preValidation: EM, preHandler: swapsOn, schema: { params: idParam } },
    async (req) => {
      const p = getPrincipal(req);
      return tx(async (trx) => {
        const me = await myEmployee(trx, p);
        const s = await trx
          .selectFrom('shift_swap_request')
          .selectAll()
          .where('id', '=', req.params.id)
          .where('counterpart_employee_id', '=', me.employee_id)
          .forUpdate()
          .executeTakeFirst();
        if (!s) throw notFound('Request');
        if (s.status !== 'open') throw new AppError('CONFLICT', 'The request is no longer open');
        await trx
          .updateTable('shift_swap_request')
          .set({ status: 'rejected', decision_note: 'declined by colleague' })
          .where('id', '=', s.id)
          .execute();
        await notifyEmp(trx, s.requester_employee_id, 'swap_declined', { requestId: s.id });
        await audit(trx, actorOf(req), {
          action: 'swap_declined',
          entityType: 'shift_swap_request',
          entityId: s.id,
          hotelId: s.hotel_id,
          companyId: me.company_id,
        });
        return { id: s.id, status: 'rejected' };
      });
    },
  );

  r.delete(
    '/me/swap-requests/:id',
    { preValidation: EM, preHandler: swapsOn, schema: { params: idParam } },
    async (req) => {
      const p = getPrincipal(req);
      return tx(async (trx) => {
        const me = await myEmployee(trx, p);
        const s = await trx
          .selectFrom('shift_swap_request')
          .selectAll()
          .where('id', '=', req.params.id)
          .where('requester_employee_id', '=', me.employee_id)
          .forUpdate()
          .executeTakeFirst();
        if (!s) throw notFound('Request');
        if (!['open', 'accepted_by_peer'].includes(s.status))
          throw new AppError('CONFLICT', 'The request can no longer be cancelled');
        await trx
          .updateTable('shift_swap_request')
          .set({ status: 'cancelled' })
          .where('id', '=', s.id)
          .execute();
        if (s.counterpart_employee_id)
          await notifyEmp(trx, s.counterpart_employee_id, 'swap_cancelled', { requestId: s.id });
        await audit(trx, actorOf(req), {
          action: 'swap_cancelled',
          entityType: 'shift_swap_request',
          entityId: s.id,
          hotelId: s.hotel_id,
          companyId: me.company_id,
        });
        return { id: s.id, status: 'cancelled' };
      });
    },
  );

  // ------------------------------------------------------------------ planners: inbox and decision
  r.get(
    '/approvals/swaps',
    {
      preValidation: planners,
      schema: {
        querystring: z.object({
          hotelIds: csvIds,
          status: z
            .enum(['open', 'accepted_by_peer', 'approved', 'rejected', 'cancelled', 'expired'])
            .default('accepted_by_peer'),
        }),
      },
    },
    async (req) => {
      const hotels = getPrincipal(req).scope.hotels(req.query.hotelIds);
      if (!hotels.length) return { items: [] };
      const rows = await db
        .selectFrom('shift_swap_request')
        .selectAll()
        .where('hotel_id', 'in', hotels)
        .where('status', '=', req.query.status)
        .orderBy('id', 'desc')
        .limit(200)
        .execute();
      const items = [];
      for (const s of rows) {
        const name = async (id: number | null) =>
          id
            ? ((
                await db
                  .selectFrom('employee')
                  .select('display_name')
                  .where('employee_id', '=', id)
                  .executeTakeFirst()
              )?.display_name ?? '')
            : null;
        const company = (
          await db
            .selectFrom('hotel')
            .select('company_id')
            .where('id', '=', s.hotel_id)
            .executeTakeFirstOrThrow()
        ).company_id;
        const violations = ['open', 'accepted_by_peer'].includes(s.status)
          ? await swapViolations(db, app.clock(), company, {
              scheduleId: s.schedule_id,
              counterpartEmployeeId: s.counterpart_employee_id,
              counterpartScheduleId: s.counterpart_schedule_id,
            }).catch(() => [])
          : [];
        items.push({
          ...swapOut(s),
          requester: await name(s.requester_employee_id),
          counterpart: await name(s.counterpart_employee_id),
          slot: await slotOf(db, s.schedule_id),
          counterpartSlot: s.counterpart_schedule_id ? await slotOf(db, s.counterpart_schedule_id) : null,
          violations,
        });
      }
      return { items };
    },
  );

  async function applySwap(
    trx: Trx,
    ctx: Ctx,
    s: Selectable<DB['shift_swap_request']>,
    overrideReason: string | undefined,
  ) {
    if (s.counterpart_schedule_id) {
      const [va, vb] = await Promise.all([
        trx
          .selectFrom('schedule')
          .select('version')
          .where('id', '=', s.schedule_id)
          .executeTakeFirstOrThrow(),
        trx
          .selectFrom('schedule')
          .select('version')
          .where('id', '=', s.counterpart_schedule_id)
          .executeTakeFirstOrThrow(),
      ]);
      await runOp(ctx, {
        op: 'swap',
        entryAId: s.schedule_id,
        versionA: va.version,
        entryBId: s.counterpart_schedule_id,
        versionB: vb.version,
        overrideReason,
      });
    } else {
      const row = await trx
        .selectFrom('schedule')
        .select('version')
        .where('id', '=', s.schedule_id)
        .executeTakeFirstOrThrow();
      await runOp(ctx, {
        op: 'update',
        entryId: s.schedule_id,
        employeeId: s.counterpart_employee_id,
        version: row.version,
        overrideReason,
      });
    }
  }

  r.put(
    '/approvals/swaps/:id',
    {
      preValidation: planners,
      schema: {
        params: idParam,
        body: z.object({
          decision: z.enum(['approve', 'reject']),
          note: z.string().max(300).optional(),
          overrideReason: z.string().min(5).max(300).optional(),
        }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      return tx(async (trx) => {
        const s = await trx
          .selectFrom('shift_swap_request')
          .selectAll()
          .where('id', '=', req.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!s) throw notFound('Request');
        p.scope.assertHotel(s.hotel_id);
        if (s.status !== 'accepted_by_peer')
          throw new AppError('CONFLICT', 'The request is not waiting for a decision');
        const now = app.clock();
        const involved = [s.requester_employee_id, s.counterpart_employee_id].filter(
          (x): x is number => x != null,
        );
        const users = await trx
          .selectFrom('employee')
          .select('user_id')
          .where('employee_id', 'in', involved)
          .execute();
        if (users.some((u) => u.user_id === p.userId))
          throw new AppError('SELF_APPROVAL', 'You cannot decide on your own swap');
        if (req.body.decision === 'approve') {
          await applySwap(trx, { trx, principal: p, actor: actorOf(req), now }, s, req.body.overrideReason);
        }
        const status = req.body.decision === 'approve' ? 'approved' : 'rejected';
        await trx
          .updateTable('shift_swap_request')
          .set({
            status,
            decided_by_user_id: p.userId,
            decided_by_role: p.role,
            decided_at: now,
            decision_note: req.body.note ?? null,
          })
          .where('id', '=', s.id)
          .execute();
        for (const e of involved)
          await notifyEmp(trx, e, 'swap_decision', {
            requestId: s.id,
            decision: status,
            note: req.body.note ?? null,
          });
        await audit(trx, actorOf(req), {
          action: `swap_${status}`,
          entityType: 'shift_swap_request',
          entityId: s.id,
          hotelId: s.hotel_id,
          reason: req.body.note ?? req.body.overrideReason ?? null,
        });
        return { id: s.id, status };
      });
    },
  );
}
