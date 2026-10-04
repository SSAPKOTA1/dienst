import type { Violation } from '@dienst/rules';
import type { Db, DbOrTrx, Trx } from '../db';
import { AppError } from '../lib/errors';
import { Scope, type Principal } from '../lib/scope';
import { checkPlan } from './planning/ops';
import { PlanEnv } from './planning/env';
import { buildPlan } from './planning/run';
import { hotelManagerUsers } from './kiosk';
import { notifyEmployee } from './planning/ops';

/** A company-wide planner identity for system-side rule checks and auto-approved swaps (never used for client requests). */
export async function systemPlanner(db: DbOrTrx, companyId: number, userId: number): Promise<Principal> {
  const hotels = await db.selectFrom('hotel').select('id').where('company_id', '=', companyId).execute();
  return {
    userId,
    role: 'admin',
    superAdminId: null,
    adminId: null,
    managerId: null,
    employeeId: null,
    scope: new Scope(
      'admin',
      [companyId],
      hotels.map((h) => h.id),
    ),
  };
}

/** Rule check of handing an entry to someone else (giveaway) or swapping two entries; reads only. */
export async function swapViolations(
  db: DbOrTrx,
  now: Date,
  companyId: number,
  req: { scheduleId: number; counterpartEmployeeId: number | null; counterpartScheduleId: number | null },
): Promise<Violation[]> {
  const sys = await systemPlanner(db, companyId, 0);
  const a = await db
    .selectFrom('schedule')
    .select(['id', 'version', 'status'])
    .where('id', '=', req.scheduleId)
    .executeTakeFirst();
  if (!a || a.status === 'cancelled') throw new AppError('CONFLICT', 'The shift no longer exists');
  let op: Record<string, unknown>;
  if (req.counterpartScheduleId) {
    const b = await db
      .selectFrom('schedule')
      .select(['version', 'status'])
      .where('id', '=', req.counterpartScheduleId)
      .executeTakeFirst();
    if (!b || b.status === 'cancelled') throw new AppError('CONFLICT', 'The other shift no longer exists');
    op = {
      op: 'swap',
      entryAId: req.scheduleId,
      versionA: a.version,
      entryBId: req.counterpartScheduleId,
      versionB: b.version,
    };
  } else if (req.counterpartEmployeeId)
    op = { op: 'update', entryId: req.scheduleId, employeeId: req.counterpartEmployeeId, version: a.version };
  else return [];
  const { plan, env } = await buildPlan(db as Db, sys, op, now);
  return plan ? checkPlan(env, plan) : [];
}

/** Rule check for one employee working a slot (open shifts); reads only. */
export async function slotViolations(
  db: DbOrTrx,
  now: Date,
  employeeId: number,
  slot: {
    hotelId: number;
    departmentId: number;
    shiftId: number | null;
    date: string;
    startMs: number;
    endMs: number;
    breakMinutes: number;
  },
): Promise<Violation[]> {
  const env = await PlanEnv.create(db, now, { employeeIds: [employeeId], from: slot.date, to: slot.date });
  return env.check({
    employeeId,
    hotelId: slot.hotelId,
    shiftId: slot.shiftId,
    departmentId: slot.departmentId,
    startMs: slot.startMs,
    endMs: slot.endMs,
    breakMinutes: slot.breakMinutes,
  });
}

/** Managers of the hotel plus the admins of its company. */
export async function plannerUsers(db: DbOrTrx, hotelId: number): Promise<number[]> {
  const mg = await hotelManagerUsers(db, hotelId);
  const ad = await db
    .selectFrom('admin_company as ac')
    .innerJoin('admin as a', 'a.admin_id', 'ac.admin_id')
    .innerJoin('hotel as h', 'h.company_id', 'ac.company_id')
    .select('a.user_id')
    .where('h.id', '=', hotelId)
    .execute();
  return [...new Set([...mg, ...ad.map((x) => x.user_id)])];
}

export async function notifyPlanners(
  trx: Trx,
  hotelId: number,
  kind: string,
  payload: Record<string, unknown>,
) {
  for (const uid of await plannerUsers(trx, hotelId))
    await trx
      .insertInto('notification')
      .values({ user_id: uid, kind, payload: JSON.stringify(payload) })
      .execute();
}

export async function notifyEmp(
  trx: Trx,
  employeeId: number,
  kind: string,
  payload: Record<string, unknown>,
) {
  const e = await trx
    .selectFrom('employee')
    .select(['employee_id', 'user_id'])
    .where('employee_id', '=', employeeId)
    .executeTakeFirst();
  if (e) await notifyEmployee(trx, { id: e.employee_id, userId: e.user_id }, kind, payload);
}

export const blocking = (v: Violation[]) => v.filter((x) => x.severity === 'block');
