import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  addDays,
  aggregate,
  mondayOf,
  validOverrideReason,
  workingMinutes,
  type Violation,
} from '@dienst/rules';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { csvIds, idParam, isoDate } from '../lib/http';
import type { Db, Trx } from '../db';
import type { Principal } from '../lib/scope';
import { buildGrid } from '../services/planning/grid';
import { findCandidates } from '../services/planning/candidates';
import { PlanEnv } from '../services/planning/env';
import {
  checkPlan,
  copyBody,
  deleteEntry,
  entryBody,
  executePlan,
  loadEntry,
  moveBody,
  planCopy,
  planCreate,
  planMove,
  planSwap,
  planUpdate,
  swapBody,
  updateBody,
  type Ctx,
  type Plan,
} from '../services/planning/ops';
import { absenceBody, createAbsence, deleteAbsence } from '../services/planning/absence';
import {
  changesInRange,
  clearWeek,
  copyWeek,
  publishWeeks,
  revertChanges,
} from '../services/planning/changes';

const SA = 'superAdmin' as const;
const AD = 'admin' as const;
const MG = 'manager' as const;
const planners = requireRole(SA, AD, MG);

const range = z.object({ hotelIds: z.array(z.number().int().positive()).min(1), from: isoDate, to: isoDate });

const validateBody = z.discriminatedUnion('operation', [
  entryBody.extend({ operation: z.literal('create') }),
  updateBody.extend({ operation: z.literal('update'), entryId: z.number().int().positive() }),
  moveBody.extend({ operation: z.literal('move') }),
  copyBody.extend({ operation: z.literal('copy') }),
  swapBody.extend({ operation: z.literal('swap') }),
  z.object({
    operation: z.literal('delete'),
    entryId: z.number().int().positive(),
    version: z.number().int().optional(),
  }),
  absenceBody.extend({ operation: z.literal('absence') }),
]);

const bulkOp = z.discriminatedUnion('op', [
  entryBody.extend({ op: z.literal('create') }),
  updateBody.extend({ op: z.literal('update'), entryId: z.number().int().positive() }),
  moveBody.extend({ op: z.literal('move') }),
  copyBody.extend({ op: z.literal('copy') }),
  swapBody.extend({ op: z.literal('swap') }),
  z.object({
    op: z.literal('delete'),
    entryId: z.number().int().positive(),
    version: z.number().int().optional(),
  }),
  absenceBody.extend({ op: z.literal('absence') }),
]);

class Rollback extends Error {
  constructor(readonly payload: unknown) {
    super('rollback');
  }
}

export async function scheduleRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  const withCtx = <T>(req: any, fn: (ctx: Ctx) => Promise<T>): Promise<T> =>
    db
      .transaction()
      .execute((trx) => fn({ trx, principal: getPrincipal(req), actor: actorOf(req), now: app.clock() }));

  /** Builds the plan for an entry operation. Reads only. */
  async function buildPlan(
    h: Db | Trx,
    p: Principal,
    op: z.infer<typeof validateBody> | (z.infer<typeof bulkOp> & { operation?: string }),
  ): Promise<{ plan: Plan | null; env: PlanEnv }> {
    const kind = 'operation' in op && op.operation ? op.operation : (op as any).op;
    const now = app.clock();
    const dayOf = (...d: Array<string | undefined>) => d.filter(Boolean) as string[];
    if (kind === 'create') {
      const i = op as z.infer<typeof entryBody>;
      const env = await PlanEnv.create(h, now, { employeeIds: [i.employeeId], from: i.date, to: i.date });
      return { env, plan: await planCreate(h, env, p, i) };
    }
    if (kind === 'update') {
      const i = op as z.infer<typeof updateBody> & { entryId: number };
      const row = await loadEntry(h, p, i.entryId);
      const ds = dayOf(row.shift_date, i.date);
      const env = await PlanEnv.create(h, now, {
        employeeIds: [row.employee_id, i.employeeId ?? row.employee_id],
        from: ds.sort()[0],
        to: ds.sort()[ds.length - 1],
      });
      return { env, plan: await planUpdate(h, env, p, i.entryId, i) };
    }
    if (kind === 'move' || kind === 'copy') {
      const i = op as z.infer<typeof moveBody>;
      const row = await loadEntry(h, p, i.entryId);
      const ds = dayOf(row.shift_date, i.toDate).sort();
      const env = await PlanEnv.create(h, now, {
        employeeIds: [row.employee_id, i.toEmployeeId ?? row.employee_id],
        from: ds[0],
        to: ds[ds.length - 1],
      });
      return { env, plan: kind === 'move' ? await planMove(h, env, p, i) : await planCopy(h, env, p, i) };
    }
    if (kind === 'swap') {
      const i = op as z.infer<typeof swapBody>;
      const a = await loadEntry(h, p, i.entryAId);
      const b = await loadEntry(h, p, i.entryBId);
      const ds = [a.shift_date, b.shift_date].sort();
      const env = await PlanEnv.create(h, now, {
        employeeIds: [a.employee_id, b.employee_id],
        from: ds[0],
        to: ds[1],
      });
      return { env, plan: await planSwap(h, env, p, i) };
    }
    if (kind === 'delete') {
      const i = op as { entryId: number };
      const row = await loadEntry(h, p, i.entryId);
      return {
        env: await PlanEnv.create(h, now, {
          employeeIds: [row.employee_id],
          from: row.shift_date,
          to: row.shift_date,
        }),
        plan: null,
      };
    }
    throw new AppError('VALIDATION', 'Unknown operation');
  }

  async function runOp(ctx: Ctx, op: any) {
    const kind = op.op ?? op.operation;
    if (kind === 'absence') return createAbsence(ctx, op);
    if (kind === 'delete') {
      const row = await loadEntry(ctx.trx, ctx.principal, op.entryId);
      const env = await PlanEnv.create(ctx.trx, ctx.now, {
        employeeIds: [row.employee_id],
        from: row.shift_date,
        to: row.shift_date,
      });
      return deleteEntry(ctx, env, op.entryId, op.version);
    }
    const { plan, env } = await buildPlan(ctx.trx, ctx.principal, op);
    return executePlan(ctx, env, plan!);
  }

  // ---------------------------------------------------------------- grid
  r.get(
    '/schedule/grid',
    {
      preValidation: planners,
      schema: {
        querystring: z.object({
          hotelIds: csvIds,
          departmentIds: csvIds,
          view: z.enum(['employee', 'shift']).default('employee'),
          range: z.enum(['week', 'month']).default('week'),
          from: isoDate,
        }),
      },
    },
    async (req) => {
      const q = req.query;
      return buildGrid(db, getPrincipal(req), app.clock(), {
        hotelIds: q.hotelIds ?? [],
        departmentIds: q.departmentIds,
        view: q.view,
        range: q.range,
        from: q.from,
      });
    },
  );

  // ---------------------------------------------------------------- validate (dry run)
  r.post('/schedule/validate', { preValidation: planners, schema: { body: validateBody } }, async (req) => {
    const p = getPrincipal(req);
    const op = req.body;
    if (op.operation === 'absence') {
      try {
        await withCtx(req, async (ctx) => {
          const res = await createAbsence(ctx, op);
          throw new Rollback(res);
        });
      } catch (e) {
        if (e instanceof Rollback)
          return { status: 'ok', violations: (e.payload as any).warnings ?? [], totals: [] };
        if (e instanceof AppError) {
          const vs = (e.details.violations as Violation[] | undefined) ?? [
            { code: e.code, severity: 'block', message: e.message, details: e.details },
          ];
          return {
            status: e.code === 'REASON_REQUIRED' ? 'needs_reason' : 'blocked',
            violations: vs,
            totals: [],
          };
        }
        throw e;
      }
    }
    const { plan, env } = await buildPlan(db, p, op);
    const override = op as { overrideReason?: string; emergencyOverride?: boolean };
    let violations: Violation[] = [];
    let status: 'ok' | 'needs_reason' | 'blocked' = 'ok';
    const totals: Array<{
      employeeId: number;
      weekStart: string;
      weekHours: number;
      targetHours: number | null;
    }> = [];
    if (plan) {
      violations = checkPlan(env, plan);
      const agg = aggregate(violations, {
        role: p.role === 'employee' ? 'manager' : p.role,
        emergencyOverride: override.emergencyOverride,
      });
      violations = agg.violations;
      status = agg.status;
      if (violations.some((v) => v.code === 'PERIOD_CLOSED')) status = 'blocked';
      if (status === 'needs_reason' && validOverrideReason(override.overrideReason)) status = 'needs_reason'; // the caller still sees that a reason is being used
      const ignore = plan.subjects.flatMap((s) => s.ignoreIds ?? []);
      const seen = new Set<string>();
      for (const s of plan.subjects) {
        const e = env.employees.get(s.employeeId)!;
        const date = env.slotLocal(s.hotelId, s.startMs, s.endMs).localDate;
        const week = mondayOf(date);
        const key = `${s.employeeId}:${week}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const added = plan.subjects
          .filter(
            (x) =>
              x.employeeId === s.employeeId &&
              mondayOf(env.slotLocal(x.hotelId, x.startMs, x.endMs).localDate) === week,
          )
          .reduce((a, x) => a + workingMinutes(x), 0);
        const c = env.contractAt(e, date);
        const weekly = c
          ? (c.weeklyTarget ?? (c.monthlyTarget != null ? (c.monthlyTarget * 12) / 52 : null))
          : null;
        totals.push({
          employeeId: s.employeeId,
          weekStart: week,
          weekHours: Math.round(((env.weekMinutes(s.employeeId, date, ignore) + added) / 60) * 10) / 10,
          targetHours: weekly != null ? Math.round(weekly * 10) / 10 : null,
        });
      }
    } else {
      const del = op as { entryId: number };
      const row = await loadEntry(db, p, del.entryId);
      const e = env.employees.get(row.employee_id)!;
      const c = env.contractAt(e, row.shift_date);
      const weekly = c
        ? (c.weeklyTarget ?? (c.monthlyTarget != null ? (c.monthlyTarget * 12) / 52 : null))
        : null;
      totals.push({
        employeeId: row.employee_id,
        weekStart: mondayOf(row.shift_date),
        weekHours: Math.round((env.weekMinutes(row.employee_id, row.shift_date, [row.id]) / 60) * 10) / 10,
        targetHours: weekly != null ? Math.round(weekly * 10) / 10 : null,
      });
      if (row.shift_date < env.today(row.hotel_id)) {
        status = 'blocked';
        violations = [
          {
            code: 'PAST_DAY',
            severity: 'block',
            message: 'The day is in the past',
            details: { date: row.shift_date },
          },
        ];
      }
    }
    return { status, violations, totals };
  });

  // ---------------------------------------------------------------- entries
  r.post(
    '/schedule/entries',
    { preValidation: planners, schema: { body: entryBody } },
    async (req, reply) => {
      const res = await withCtx(req, (ctx) => runOp(ctx, { ...req.body, op: 'create' }));
      return reply.status(201).send(res);
    },
  );
  r.put(
    '/schedule/entries/:id',
    { preValidation: planners, schema: { params: idParam, body: updateBody } },
    async (req) => withCtx(req, (ctx) => runOp(ctx, { ...req.body, entryId: req.params.id, op: 'update' })),
  );
  r.delete(
    '/schedule/entries/:id',
    {
      preValidation: planners,
      schema: { params: idParam, querystring: z.object({ version: z.coerce.number().int().optional() }) },
    },
    async (req) =>
      withCtx(req, (ctx) => runOp(ctx, { entryId: req.params.id, version: req.query.version, op: 'delete' })),
  );
  r.post('/schedule/move', { preValidation: planners, schema: { body: moveBody } }, async (req) =>
    withCtx(req, (ctx) => runOp(ctx, { ...req.body, op: 'move' })),
  );
  r.post('/schedule/copy', { preValidation: planners, schema: { body: copyBody } }, async (req, reply) =>
    reply.status(201).send(await withCtx(req, (ctx) => runOp(ctx, { ...req.body, op: 'copy' }))),
  );
  r.post('/schedule/swap', { preValidation: planners, schema: { body: swapBody } }, async (req) =>
    withCtx(req, (ctx) => runOp(ctx, { ...req.body, op: 'swap' })),
  );

  r.post(
    '/schedule/copy-week',
    {
      preValidation: planners,
      schema: {
        body: z.object({
          hotelIds: z.array(z.number().int().positive()).min(1),
          departmentIds: z.array(z.number().int().positive()).optional(),
          fromWeek: isoDate,
          toWeek: isoDate,
        }),
      },
    },
    async (req) =>
      withCtx(req, (ctx) =>
        copyWeek(ctx, req.body.hotelIds, req.body.departmentIds, req.body.fromWeek, req.body.toWeek),
      ),
  );

  r.post(
    '/schedule/bulk',
    { preValidation: planners, schema: { body: z.object({ operations: z.array(bulkOp).min(1).max(200) }) } },
    async (req) =>
      withCtx(req, async (ctx) => {
        const results: unknown[] = [];
        for (const [index, op] of req.body.operations.entries()) {
          try {
            results.push(await runOp(ctx, op));
          } catch (e) {
            if (e instanceof AppError)
              throw new AppError(e.code, e.message, { ...e.details, operationIndex: index });
            throw e;
          }
        }
        return { results };
      }),
  );

  // ---------------------------------------------------------------- absences
  r.post(
    '/schedule/absence',
    { preValidation: planners, schema: { body: absenceBody } },
    async (req, reply) => reply.status(201).send(await withCtx(req, (ctx) => createAbsence(ctx, req.body))),
  );
  r.delete('/schedule/absence/:id', { preValidation: planners, schema: { params: idParam } }, async (req) =>
    withCtx(req, (ctx) => deleteAbsence(ctx, req.params.id)),
  );

  // ---------------------------------------------------------------- publish, changes, revert, clear
  r.post('/schedule/publish', { preValidation: planners, schema: { body: range } }, async (req) =>
    withCtx(req, (ctx) => publishWeeks(ctx, req.body.hotelIds, req.body.from, req.body.to)),
  );
  r.get(
    '/schedule/changes',
    {
      preValidation: planners,
      schema: { querystring: z.object({ hotelIds: csvIds, from: isoDate, to: isoDate }) },
    },
    async (req) => {
      const hotels = getPrincipal(req).scope.hotels(req.query.hotelIds);
      const to = req.query.to < addDays(req.query.from, 0) ? req.query.from : req.query.to;
      return { changes: await changesInRange(db, hotels, req.query.from, to) };
    },
  );
  r.post(
    '/schedule/revert',
    {
      preValidation: planners,
      schema: { body: range.extend({ entryId: z.number().int().positive().optional() }) },
    },
    async (req) =>
      withCtx(req, (ctx) =>
        revertChanges(ctx, req.body.hotelIds, req.body.from, req.body.to, req.body.entryId),
      ),
  );
  r.post('/schedule/clear-week', { preValidation: planners, schema: { body: range } }, async (req) =>
    withCtx(req, (ctx) => clearWeek(ctx, req.body.hotelIds, req.body.from, req.body.to)),
  );

  // ---------------------------------------------------------------- substitute finder
  r.get(
    '/schedule/candidates',
    {
      preValidation: planners,
      schema: {
        querystring: z.object({
          hotelIds: csvIds,
          departmentId: z.coerce.number().int().optional(),
          date: isoDate,
          shiftId: z.coerce.number().int().optional(),
          start: z.string().optional(),
          end: z.string().optional(),
          includeBlocked: z.enum(['true', 'false']).optional(),
        }),
      },
    },
    async (req) => ({
      items: await findCandidates(db, getPrincipal(req), app.clock(), {
        hotelIds: req.query.hotelIds ?? [],
        departmentId: req.query.departmentId,
        date: req.query.date,
        shiftId: req.query.shiftId,
        start: req.query.start,
        end: req.query.end,
        includeBlocked: req.query.includeBlocked === 'true',
      }),
    }),
  );
  void notFound;
}
