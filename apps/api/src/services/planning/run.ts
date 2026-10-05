import type { Db, Trx } from '../../db';
import { AppError } from '../../lib/errors';
import type { Principal } from '../../lib/scope';
import { createAbsence } from './absence';
import { PlanEnv } from './env';
import {
  deleteEntry,
  executePlan,
  loadEntry,
  planCopy,
  planCreate,
  planMove,
  planSwap,
  planUpdate,
  type Ctx,
  type EntryInput,
  type Plan,
  type UpdateInput,
} from './ops';

/** Builds the plan for an entry operation. Reads only. */
export async function buildPlan(
  h: Db | Trx,
  p: Principal,
  op: any,
  now: Date,
): Promise<{ plan: Plan | null; env: PlanEnv }> {
  const kind = 'operation' in op && op.operation ? op.operation : (op as any).op;
  const dayOf = (...d: Array<string | undefined>) => d.filter(Boolean) as string[];
  if (kind === 'create') {
    const i = op as EntryInput;
    const env = await PlanEnv.create(h, now, { employeeIds: [i.employeeId], from: i.date, to: i.date });
    return { env, plan: await planCreate(h, env, p, i) };
  }
  if (kind === 'update') {
    const i = op as UpdateInput & { entryId: number };
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
    const i = op as any;
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
    const i = op as any;
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

export async function runOp(ctx: Ctx, op: any) {
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
  const { plan, env } = await buildPlan(ctx.trx, ctx.principal, op, ctx.now);
  return executePlan(ctx, env, plan!);
}
