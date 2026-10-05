import { z } from 'zod';
import {
  addDays,
  aggregate,
  requiredBreakMinutes,
  validOverrideReason,
  workingMinutes,
  type Violation,
} from '@dienst/rules';
import type { Trx, DbOrTrx } from '../../db';
import { AppError, notFound } from '../../lib/errors';
import { audit, type Actor } from '../../lib/audit';
import { hhmm, isoDate } from '../../lib/http';
import type { Principal } from '../../lib/scope';
import { isoWithOffset, localMinutes, zonedInstant } from '../../lib/time';
import { PlanEnv, type EntryRow, type Subject } from './env';

export const overrideFields = {
  overrideReason: z.string().min(5).max(300).optional(),
  emergencyOverride: z.boolean().optional(),
};

export const entryBody = z.object({
  hotelId: z.number().int().positive(),
  employeeId: z.number().int().positive(),
  shiftId: z.number().int().positive().nullish(),
  date: isoDate,
  start: hhmm.optional(),
  end: hhmm.optional(),
  plannedBreakMinutes: z.number().int().min(0).max(240).optional(),
  ...overrideFields,
});
export type EntryInput = z.infer<typeof entryBody>;

export const updateBody = entryBody.partial().extend({ version: z.number().int().positive() });
export type UpdateInput = z.infer<typeof updateBody>;

export const moveBody = z.object({
  entryId: z.number().int().positive(),
  version: z.number().int().positive(),
  toEmployeeId: z.number().int().positive().optional(),
  toDate: isoDate.optional(),
  toShiftId: z.number().int().positive().optional(),
  ...overrideFields,
});
export const copyBody = moveBody.omit({ version: true });
export const swapBody = z.object({
  entryAId: z.number().int().positive(),
  versionA: z.number().int().positive(),
  entryBId: z.number().int().positive(),
  versionB: z.number().int().positive(),
  ...overrideFields,
});

export interface Ctx {
  trx: Trx;
  principal: Principal;
  actor: Actor;
  now: Date;
}

export const creatorRole = (p: Principal) =>
  p.role === 'superAdmin' ? 'super_admin' : (p.role as 'admin' | 'manager');

// ---------------------------------------------------------------------------------------------
// slots

export interface Slot {
  hotelId: number;
  shiftId: number | null;
  departmentId: number | null;
  date: string;
  startMs: number;
  endMs: number;
  breakMinutes: number;
}

const t5 = (s: string) => String(s).slice(0, 5);

export async function slotFromInput(
  db: DbOrTrx,
  env: PlanEnv,
  i: {
    hotelId: number;
    shiftId?: number | null;
    date: string;
    start?: string;
    end?: string;
    plannedBreakMinutes?: number;
  },
): Promise<Slot> {
  const tz = env.hotel(i.hotelId).tz;
  let start = i.start;
  let end = i.end;
  let departmentId: number | null = null;
  let breakDefault: number | null = null;
  if (i.shiftId) {
    const s = await db.selectFrom('shift').selectAll().where('id', '=', i.shiftId).executeTakeFirst();
    if (!s || s.hotel_id !== i.hotelId)
      throw new AppError('VALIDATION', 'The shift does not belong to this hotel');
    start = start ?? t5(s.start_time); // explicit times win over the template
    end = end ?? t5(s.end_time);
    departmentId = s.department_id;
    breakDefault = s.break_duration_minutes;
  }
  if (!start || !end) throw new AppError('VALIDATION', 'start and end (or a shiftId) are required');
  const startMs = zonedInstant(i.date, start, tz).getTime();
  const endMs = zonedInstant(end <= start ? addDays(i.date, 1) : i.date, end, tz).getTime();
  const gross = (endMs - startMs) / 60000;
  return {
    hotelId: i.hotelId,
    shiftId: i.shiftId ?? null,
    departmentId,
    date: i.date,
    startMs,
    endMs,
    breakMinutes: i.plannedBreakMinutes ?? breakDefault ?? requiredBreakMinutes(gross),
  };
}

/** Same local clock time and duration on another date (used by move / copy / swap). */
export function shiftToDate(env: PlanEnv, row: EntryRow, date: string): { startMs: number; endMs: number } {
  const tz = env.hotel(row.hotel_id).tz;
  const startHm = hm(localMinutes(row.planned_start, tz));
  const endLocal = env.slotLocal(
    row.hotel_id,
    row.planned_start.getTime(),
    row.planned_end.getTime(),
  ).endLocalMin;
  const dayOffset = Math.floor(endLocal / 1440);
  const endHm = hm(endLocal % 1440);
  return {
    startMs: zonedInstant(date, startHm, tz).getTime(),
    endMs: zonedInstant(addDays(date, dayOffset), endHm, tz).getTime(),
  };
}
const hm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export const hoursOf = (e: { startMs: number; endMs: number; breakMinutes: number }) =>
  Math.round((workingMinutes(e) / 60) * 100) / 100;

// ---------------------------------------------------------------------------------------------
// enforcement

export interface Enforced {
  warnings: Violation[];
  needsReason: Violation[];
  overridden: string[];
}

/**
 * Applies SPEC 4.3 aggregation to the violations of one or more subjects:
 * blocked -> RULE_BLOCKED (PERIOD_CLOSED -> 409), needs_reason without a valid reason -> REASON_REQUIRED.
 */
export function enforce(
  violations: Violation[],
  p: Principal,
  o: { overrideReason?: string; emergencyOverride?: boolean },
): Enforced {
  if (violations.some((v) => v.code === 'PERIOD_CLOSED')) {
    throw new AppError('PERIOD_CLOSED', 'The payroll period is closed', { violations });
  }
  const agg = aggregate(violations, {
    role: p.role === 'employee' ? 'manager' : p.role,
    emergencyOverride: o.emergencyOverride,
  });
  if (agg.status === 'blocked')
    throw new AppError('RULE_BLOCKED', 'The planning rules block this change', {
      violations: agg.violations,
    });
  const needsReason = agg.violations.filter((v) => v.severity === 'needs_reason');
  if (agg.status === 'needs_reason' && !validOverrideReason(o.overrideReason)) {
    throw new AppError('REASON_REQUIRED', 'A reason (5-300 characters) is required', {
      violations: agg.violations,
    });
  }
  return {
    warnings: agg.violations.filter((v) => v.severity === 'warn'),
    needsReason,
    overridden: agg.overridden,
  };
}

export async function auditOverrides(
  ctx: Ctx,
  e: Enforced,
  reason: string | undefined,
  entityId: number | null,
  hotelId: number,
  companyId: number,
) {
  if (!e.needsReason.length) return;
  await audit(ctx.trx, ctx.actor, {
    action: 'rule_override',
    entityType: 'schedule',
    entityId,
    hotelId,
    companyId,
    reason: reason?.trim(),
    new: { codes: e.needsReason.map((v) => v.code), emergency: e.overridden },
  });
}

// ---------------------------------------------------------------------------------------------
// loading helpers

export async function loadEmployeeFor(env: PlanEnv, p: Principal, employeeId: number, hotelId: number) {
  const emp = env.employees.get(employeeId);
  if (!emp || emp.companyId !== env.hotel(hotelId).companyId) throw notFound('Employee');
  p.scope.assertHotel(hotelId);
  return emp;
}

export async function loadEntry(
  trx: DbOrTrx,
  p: Principal,
  id: number,
  opts: { forUpdate?: boolean } = {},
): Promise<EntryRow> {
  let q = trx.selectFrom('schedule').selectAll().where('id', '=', id);
  if (opts.forUpdate && 'transaction' in trx === false) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row || row.status === 'cancelled') throw notFound('Schedule entry');
  p.scope.assertHotel(row.hotel_id);
  return row as EntryRow;
}

export function assertVersion(row: EntryRow, version: number) {
  if (row.version !== version)
    throw new AppError('VERSION_CONFLICT', 'The entry was changed by someone else', {
      currentVersion: row.version,
    });
}

/** An existing entry on a past or closed day cannot be changed. */
export function assertEditable(env: PlanEnv, row: EntryRow) {
  const v: Violation[] = [];
  if (row.shift_date < env.today(row.hotel_id))
    v.push({
      code: 'PAST_DAY',
      severity: 'block',
      message: 'The day is in the past',
      details: { date: row.shift_date },
    });
  if (env.isClosed(row.hotel_id, row.shift_date))
    v.push({
      code: 'PERIOD_CLOSED',
      severity: 'block',
      message: 'The payroll period is closed',
      details: { date: row.shift_date },
    });
  if (v.some((x) => x.code === 'PERIOD_CLOSED'))
    throw new AppError('PERIOD_CLOSED', 'The payroll period is closed', { violations: v });
  if (v.length) throw new AppError('RULE_BLOCKED', 'The day is locked', { violations: v });
}

// ---------------------------------------------------------------------------------------------
// notifications

export async function notifyEmployee(
  trx: Trx,
  emp: { id: number; userId: number },
  kind: string,
  payload: Record<string, unknown>,
) {
  await trx
    .insertInto('notification')
    .values({ user_id: emp.userId, employee_id: emp.id, kind, payload: JSON.stringify(payload) })
    .execute();
}

// ---------------------------------------------------------------------------------------------
// plans: subjects to check + effect to apply

export interface Plan {
  subjects: Subject[];
  hotelId: number;
  companyId: number;
  override: { overrideReason?: string; emergencyOverride?: boolean };
  /** employee ids whose totals change */
  affected: number[];
  /** dates (hotel-local) the plan touches, used for totals */
  dates: string[];
  apply: (ctx: Ctx) => Promise<Record<string, unknown>>;
}

const subjectOf = (
  s: Slot,
  employeeId: number,
  ignore: number[] = [],
  entryId: number | null = null,
): Subject => ({
  employeeId,
  hotelId: s.hotelId,
  shiftId: s.shiftId,
  departmentId: s.departmentId,
  startMs: s.startMs,
  endMs: s.endMs,
  breakMinutes: s.breakMinutes,
  ignoreIds: ignore,
  entryId,
});

export const rowOut = (r: EntryRow) => ({
  id: r.id,
  version: r.version,
  hotelId: r.hotel_id,
  employeeId: r.employee_id,
  shiftId: r.shift_id,
  date: r.shift_date,
  start: r.planned_start,
  end: r.planned_end,
  breakMinutes: r.planned_break_minutes,
  status: r.status,
});

async function insertDraft(ctx: Ctx, s: Slot, employeeId: number) {
  return ctx.trx
    .insertInto('schedule')
    .values({
      hotel_id: s.hotelId,
      employee_id: employeeId,
      shift_id: s.shiftId,
      shift_date: s.date,
      planned_start: new Date(s.startMs),
      planned_end: new Date(s.endMs),
      planned_break_minutes: s.breakMinutes,
      status: 'draft',
      created_by_user_id: ctx.principal.userId,
      created_by_role: creatorRole(ctx.principal),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function planCreate(db: DbOrTrx, env: PlanEnv, p: Principal, i: EntryInput): Promise<Plan> {
  p.scope.assertHotel(i.hotelId);
  const emp = await loadEmployeeFor(env, p, i.employeeId, i.hotelId);
  const slot = await slotFromInput(db, env, i);
  const hotel = env.hotel(i.hotelId);
  return {
    subjects: [subjectOf(slot, emp.id)],
    hotelId: i.hotelId,
    companyId: hotel.companyId,
    override: i,
    affected: [emp.id],
    dates: [slot.date],
    apply: async (ctx) => {
      const row = await insertDraft(ctx, slot, emp.id);
      await audit(ctx.trx, ctx.actor, {
        action: 'schedule_entry_created',
        entityType: 'schedule',
        entityId: row.id,
        hotelId: row.hotel_id,
        companyId: hotel.companyId,
        new: rowOut(row),
      });
      return { entry: rowOut(row) };
    },
  };
}

export async function planUpdate(
  db: DbOrTrx,
  env: PlanEnv,
  p: Principal,
  id: number,
  i: UpdateInput,
): Promise<Plan> {
  const row = await loadEntry(db, p, id);
  assertVersion(row, i.version);
  assertEditable(env, row);
  const hotelId = i.hotelId ?? row.hotel_id;
  p.scope.assertHotel(hotelId);
  const empId = i.employeeId ?? row.employee_id;
  const emp = await loadEmployeeFor(env, p, empId, hotelId);
  const date = i.date ?? row.shift_date;
  const tz = env.hotel(hotelId).tz;
  const timesGiven =
    i.start !== undefined ||
    i.end !== undefined ||
    i.shiftId !== undefined ||
    i.date !== undefined ||
    i.plannedBreakMinutes !== undefined;
  const shiftId = i.shiftId === undefined ? row.shift_id : i.shiftId;
  const shiftChanged = shiftId !== row.shift_id;
  let slot: Slot;
  if (timesGiven) {
    slot = await slotFromInput(db, env, {
      hotelId,
      shiftId,
      date,
      start: i.start ?? (shiftChanged ? undefined : hm(localMinutes(row.planned_start, tz))),
      end: i.end ?? (shiftChanged ? undefined : hm(localMinutes(row.planned_end, tz))),
      plannedBreakMinutes: i.plannedBreakMinutes ?? (shiftChanged ? undefined : row.planned_break_minutes),
    });
  } else {
    slot = {
      hotelId,
      shiftId: row.shift_id,
      departmentId: row.shift_id
        ? ((
            await db
              .selectFrom('shift')
              .select('department_id')
              .where('id', '=', row.shift_id)
              .executeTakeFirst()
          )?.department_id ?? null)
        : null,
      date: row.shift_date,
      startMs: row.planned_start.getTime(),
      endMs: row.planned_end.getTime(),
      breakMinutes: row.planned_break_minutes,
    };
  }
  const oldEmp = env.employees.get(row.employee_id);
  const hotel = env.hotel(hotelId);
  return {
    subjects: [subjectOf(slot, emp.id, [row.id], row.id)],
    hotelId,
    companyId: hotel.companyId,
    override: i,
    affected: [emp.id, row.employee_id],
    dates: [slot.date, row.shift_date],
    apply: async (ctx) => {
      const upd = await ctx.trx
        .updateTable('schedule')
        .set({
          hotel_id: hotelId,
          employee_id: emp.id,
          shift_id: slot.shiftId,
          shift_date: slot.date,
          planned_start: new Date(slot.startMs),
          planned_end: new Date(slot.endMs),
          planned_break_minutes: slot.breakMinutes,
          version: row.version + 1,
          updated_at: ctx.now,
        })
        .where('id', '=', row.id)
        .where('version', '=', row.version)
        .returningAll()
        .executeTakeFirst();
      if (!upd) throw new AppError('VERSION_CONFLICT', 'The entry was changed by someone else');
      await audit(ctx.trx, ctx.actor, {
        action: 'schedule_entry_updated',
        entityType: 'schedule',
        entityId: row.id,
        hotelId,
        companyId: hotel.companyId,
        old: rowOut(row),
        new: rowOut(upd),
      });
      if (row.status === 'published') {
        await notifyEmployee(ctx.trx, emp, 'schedule_changed', {
          entryId: row.id,
          hotelId,
          date: slot.date,
          change: 'changed',
        });
        if (oldEmp && oldEmp.id !== emp.id)
          await notifyEmployee(ctx.trx, oldEmp, 'schedule_changed', {
            entryId: row.id,
            hotelId: row.hotel_id,
            date: row.shift_date,
            change: 'removed',
          });
      }
      return { entry: rowOut(upd) };
    },
  };
}

export async function deleteEntry(ctx: Ctx, env: PlanEnv, id: number, version?: number) {
  const row = await loadEntry(ctx.trx, ctx.principal, id);
  if (version !== undefined) assertVersion(row, version);
  assertEditable(env, row);
  const hotel = env.hotel(row.hotel_id);
  if (row.status === 'draft') {
    await ctx.trx.deleteFrom('schedule').where('id', '=', row.id).execute();
  } else {
    await ctx.trx
      .updateTable('schedule')
      .set({ status: 'cancelled', cancel_reason: 'changed', version: row.version + 1, updated_at: ctx.now })
      .where('id', '=', row.id)
      .execute();
    const emp = env.employees.get(row.employee_id);
    if (emp)
      await notifyEmployee(ctx.trx, emp, 'schedule_changed', {
        entryId: row.id,
        hotelId: row.hotel_id,
        date: row.shift_date,
        change: 'removed',
      });
  }
  await audit(ctx.trx, ctx.actor, {
    action: 'schedule_entry_deleted',
    entityType: 'schedule',
    entityId: row.id,
    hotelId: row.hotel_id,
    companyId: hotel.companyId,
    old: rowOut(row),
  });
  return { deleted: true, cancelled: row.status !== 'draft' };
}

async function moveTarget(
  db: DbOrTrx,
  env: PlanEnv,
  p: Principal,
  row: EntryRow,
  i: { toEmployeeId?: number; toDate?: string; toShiftId?: number },
) {
  const empId = i.toEmployeeId ?? row.employee_id;
  const date = i.toDate ?? row.shift_date;
  let slot: Slot;
  if (i.toShiftId) {
    const sh = await db
      .selectFrom('shift')
      .select('hotel_id')
      .where('id', '=', i.toShiftId)
      .executeTakeFirst();
    if (!sh) throw notFound('Shift');
    p.scope.assertHotel(sh.hotel_id);
    slot = await slotFromInput(db, env, { hotelId: sh.hotel_id, shiftId: i.toShiftId, date });
  } else {
    const t = shiftToDate(env, row, date);
    const dept = row.shift_id
      ? ((
          await db
            .selectFrom('shift')
            .select('department_id')
            .where('id', '=', row.shift_id)
            .executeTakeFirst()
        )?.department_id ?? null)
      : null;
    slot = {
      hotelId: row.hotel_id,
      shiftId: row.shift_id,
      departmentId: dept,
      date,
      startMs: t.startMs,
      endMs: t.endMs,
      breakMinutes: row.planned_break_minutes,
    };
  }
  const emp = await loadEmployeeFor(env, p, empId, slot.hotelId);
  return { slot, emp };
}

export async function planMove(
  db: DbOrTrx,
  env: PlanEnv,
  p: Principal,
  i: z.infer<typeof moveBody>,
): Promise<Plan> {
  const row = await loadEntry(db, p, i.entryId);
  assertVersion(row, i.version);
  assertEditable(env, row);
  const { slot, emp } = await moveTarget(db, env, p, row, i);
  const hotel = env.hotel(slot.hotelId);
  const oldEmp = env.employees.get(row.employee_id);
  return {
    subjects: [subjectOf(slot, emp.id, [row.id], row.id)],
    hotelId: slot.hotelId,
    companyId: hotel.companyId,
    override: i,
    affected: [emp.id, row.employee_id],
    dates: [slot.date, row.shift_date],
    apply: async (ctx) => {
      const upd = await ctx.trx
        .updateTable('schedule')
        .set({
          hotel_id: slot.hotelId,
          employee_id: emp.id,
          shift_id: slot.shiftId,
          shift_date: slot.date,
          planned_start: new Date(slot.startMs),
          planned_end: new Date(slot.endMs),
          planned_break_minutes: slot.breakMinutes,
          version: row.version + 1,
          updated_at: ctx.now,
        })
        .where('id', '=', row.id)
        .where('version', '=', row.version)
        .returningAll()
        .executeTakeFirst();
      if (!upd) throw new AppError('VERSION_CONFLICT', 'The entry was changed by someone else');
      await audit(ctx.trx, ctx.actor, {
        action: 'schedule_entry_moved',
        entityType: 'schedule',
        entityId: row.id,
        hotelId: slot.hotelId,
        companyId: hotel.companyId,
        old: rowOut(row),
        new: rowOut(upd),
      });
      if (row.status === 'published') {
        await notifyEmployee(ctx.trx, emp, 'schedule_changed', {
          entryId: row.id,
          hotelId: slot.hotelId,
          date: slot.date,
          change: 'changed',
        });
        if (oldEmp && oldEmp.id !== emp.id)
          await notifyEmployee(ctx.trx, oldEmp, 'schedule_changed', {
            entryId: row.id,
            hotelId: row.hotel_id,
            date: row.shift_date,
            change: 'removed',
          });
      }
      return { entry: rowOut(upd) };
    },
  };
}

export async function planCopy(
  db: DbOrTrx,
  env: PlanEnv,
  p: Principal,
  i: z.infer<typeof copyBody>,
): Promise<Plan> {
  const row = await loadEntry(db, p, i.entryId);
  const { slot, emp } = await moveTarget(db, env, p, row, i);
  const hotel = env.hotel(slot.hotelId);
  return {
    subjects: [subjectOf(slot, emp.id)],
    hotelId: slot.hotelId,
    companyId: hotel.companyId,
    override: i,
    affected: [emp.id],
    dates: [slot.date],
    apply: async (ctx) => {
      const created = await insertDraft(ctx, slot, emp.id);
      await audit(ctx.trx, ctx.actor, {
        action: 'schedule_entry_copied',
        entityType: 'schedule',
        entityId: created.id,
        hotelId: slot.hotelId,
        companyId: hotel.companyId,
        new: { ...rowOut(created), copiedFrom: row.id },
      });
      return { entry: rowOut(created) };
    },
  };
}

/** Swap: each entry takes the other's (employee, date) slot and keeps its own time of day. */
export async function planSwap(
  db: DbOrTrx,
  env: PlanEnv,
  p: Principal,
  i: z.infer<typeof swapBody>,
): Promise<Plan> {
  const a = await loadEntry(db, p, i.entryAId);
  const b = await loadEntry(db, p, i.entryBId);
  assertVersion(a, i.versionA);
  assertVersion(b, i.versionB);
  assertEditable(env, a);
  assertEditable(env, b);
  if (a.id === b.id) throw new AppError('VALIDATION', 'Cannot swap an entry with itself');
  const aTarget = await moveTarget(db, env, p, a, { toEmployeeId: b.employee_id, toDate: b.shift_date });
  const bTarget = await moveTarget(db, env, p, b, { toEmployeeId: a.employee_id, toDate: a.shift_date });
  const ignore = [a.id, b.id];
  const sa = subjectOf(aTarget.slot, aTarget.emp.id, ignore, a.id);
  const sb = subjectOf(bTarget.slot, bTarget.emp.id, ignore, b.id);
  const hotel = env.hotel(aTarget.slot.hotelId);
  return {
    subjects: [sa, sb],
    hotelId: aTarget.slot.hotelId,
    companyId: hotel.companyId,
    override: i,
    affected: [a.employee_id, b.employee_id],
    dates: [a.shift_date, b.shift_date],
    apply: async (ctx) => {
      const far = (ms: number) => new Date(ms + 100 * 365 * 86400e3);
      // park A far away so the two moves cannot collide with each other, then place both
      await ctx.trx
        .updateTable('schedule')
        .set({ planned_start: far(a.planned_start.getTime()), planned_end: far(a.planned_end.getTime()) })
        .where('id', '=', a.id)
        .execute();
      const place = async (row: EntryRow, t: { slot: Slot; emp: { id: number } }) =>
        ctx.trx
          .updateTable('schedule')
          .set({
            employee_id: t.emp.id,
            shift_date: t.slot.date,
            planned_start: new Date(t.slot.startMs),
            planned_end: new Date(t.slot.endMs),
            version: row.version + 1,
            updated_at: ctx.now,
          })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      const nb = await place(b, bTarget);
      const na = await place(a, aTarget);
      await audit(ctx.trx, ctx.actor, {
        action: 'schedule_entries_swapped',
        entityType: 'schedule',
        entityId: a.id,
        hotelId: hotel.id,
        companyId: hotel.companyId,
        old: [rowOut(a), rowOut(b)],
        new: [rowOut(na), rowOut(nb)],
      });
      for (const [row, now] of [
        [a, na],
        [b, nb],
      ] as const) {
        if (row.status === 'published') {
          const e = env.employees.get(now.employee_id);
          if (e)
            await notifyEmployee(ctx.trx, e, 'schedule_changed', {
              entryId: row.id,
              hotelId: row.hotel_id,
              date: now.shift_date,
              change: 'changed',
            });
        }
      }
      return { entries: [rowOut(na), rowOut(nb)] };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// execution

/** Checks a plan against the rules (no writes). Subjects of the same employee see each other. */
export function checkPlan(env: PlanEnv, plan: Plan): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>();
  for (const s of plan.subjects) {
    for (const v of env.check(s, plan.subjects)) {
      const k = `${v.code}|${JSON.stringify(v.details)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

export async function executePlan(ctx: Ctx, env: PlanEnv, plan: Plan) {
  const violations = checkPlan(env, plan);
  const enforced = enforce(violations, ctx.principal, plan.override);
  const result = await plan.apply(ctx);
  const id = (result.entry as { id: number } | undefined)?.id ?? null;
  await auditOverrides(ctx, enforced, plan.override.overrideReason, id, plan.hotelId, plan.companyId);
  return { ...result, warnings: enforced.warnings };
}

export { isoWithOffset };
