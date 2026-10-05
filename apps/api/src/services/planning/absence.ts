import type { DB } from '../../db';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import { addDays, countedDays, eachDay, sickBackdateAllowed } from '@dienst/rules';
import { MENU_ABSENCE_TYPES } from '@dienst/shared';
import type { Trx, DbOrTrx } from '../../db';
import { AppError, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { isoDate } from '../../lib/http';
import { localDate } from '../../lib/time';
import { resolveHolidays } from '../holidays';
import { ensureAllowance, remainingDays } from '../vacation';
import { PlanEnv } from './env';
import { leaveLimitIssues } from '../leave';
import { buildLedger } from '../timeAccount';
import { enforce, notifyEmployee, type Ctx } from './ops';
import type { Principal } from '../../lib/scope';

export const absenceBody = z.object({
  employeeId: z.number().int().positive(),
  from: isoDate,
  to: isoDate,
  type: z.enum(MENU_ABSENCE_TYPES),
  /** single-day half day of annual leave (counts 0.5, does not cancel the day's entries) */
  halfDay: z.enum(['morning', 'afternoon']).optional(),
  reason: z.string().max(500).optional(),
  certificateStatus: z.enum(['not_required', 'pending', 'received']).optional(),
  overrideReason: z.string().min(5).max(300).optional(),
});
export type AbsenceInput = z.infer<typeof absenceBody>;

/** A planner may touch an employee who works at one of their hotels (manager) or in their company (admin). */
export async function assertPlannerEmployee(db: DbOrTrx, p: Principal, employeeId: number) {
  const e = await db
    .selectFrom('employee')
    .selectAll()
    .where('employee_id', '=', employeeId)
    .executeTakeFirst();
  if (!e) throw notFound('Employee');
  if (p.role === 'manager') {
    const hs = await db
      .selectFrom('employee_hotel')
      .select('hotel_id')
      .where('employee_id', '=', employeeId)
      .execute();
    const ids = new Set([e.primary_hotel_id, ...hs.map((h) => h.hotel_id)]);
    if (![...ids].some((h) => p.scope.canHotel(h)))
      throw new AppError('FORBIDDEN_SCOPE', 'Employee is outside your hotels');
  } else p.scope.assertCompany(e.company_id);
  return e;
}

const yearsOf = (days: string[]) => {
  const m = new Map<number, number>();
  for (const d of days) m.set(Number(d.slice(0, 4)), (m.get(Number(d.slice(0, 4))) ?? 0) + 1);
  return m;
};

/** Past/backdating rule shared by create and delete (SPEC 4.4). */
async function checkPast(
  trx: DbOrTrx,
  p: Principal,
  today: string,
  from: string,
  type: string,
  companyId: number,
  reason: string | undefined,
) {
  if (from >= today) return { backdateReason: null as string | null };
  if (type !== 'sick_leave')
    throw new AppError('RULE_BLOCKED', 'Only sick leave may be entered for past days', {
      violations: [
        { code: 'PAST_DAY', severity: 'block', message: 'The day is in the past', details: { date: from } },
      ],
    });
  const company = await trx
    .selectFrom('company')
    .select('sick_backdate_days')
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  const limit = company.sick_backdate_days;
  if (sickBackdateAllowed(today, from, limit)) return { backdateReason: null };
  if (p.role === 'manager')
    throw new AppError('RULE_BLOCKED', `Managers may enter sick leave at most ${limit} days back`, {
      violations: [
        {
          code: 'SICK_BACKDATE',
          severity: 'block',
          message: 'Too far in the past for a manager',
          details: { limitDays: limit },
        },
      ],
    });
  if (!reason || reason.trim().length < 5)
    throw new AppError('REASON_REQUIRED', 'A reason is required for sick leave this far back', {
      violations: [
        {
          code: 'SICK_BACKDATE',
          severity: 'needs_reason',
          message: 'Backdating needs a reason',
          details: { limitDays: limit },
        },
      ],
    });
  return { backdateReason: reason.trim() };
}

export async function createAbsence(ctx: Ctx, input: AbsenceInput) {
  const { trx, principal: p } = ctx;
  if (input.to < input.from) throw new AppError('VALIDATION', 'to must not be before from');
  const emp = await assertPlannerEmployee(trx, p, input.employeeId);
  const env = await PlanEnv.create(trx, ctx.now, {
    employeeIds: [emp.employee_id],
    from: input.from,
    to: input.to,
  });
  const pe = env.employees.get(emp.employee_id)!;
  const contract =
    env.contractAt(pe, input.from) ??
    pe.contracts
      .filter((c) => c.validFrom <= input.to)
      .sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
  if (!contract)
    throw new AppError('RULE_BLOCKED', 'No contract for these dates', {
      violations: [
        { code: 'CONTRACT_INACTIVE', severity: 'block', message: 'No active contract', details: {} },
      ],
    });
  const tz = env.hotel(emp.primary_hotel_id).tz;
  const today = localDate(ctx.now, tz);
  const { backdateReason } = await checkPast(
    trx,
    p,
    today,
    input.from,
    input.type,
    emp.company_id,
    input.reason,
  );

  // closed periods (any hotel of the employee), punches
  for (const d of eachDay(input.from, input.to)) {
    for (const h of pe.hotelIds)
      if (env.isClosed(h, d))
        throw new AppError('PERIOD_CLOSED', 'The payroll period is closed', { date: d });
  }
  const punch = await trx
    .selectFrom('punch_record')
    .select('id')
    .where('employee_id', '=', emp.employee_id)
    .where('shift_date', '>=', input.from)
    .where('shift_date', '<=', input.to)
    .where('approval_status', '<>', 'rejected')
    .limit(1)
    .executeTakeFirst();
  if (punch && !input.halfDay)
    throw new AppError('PUNCH_EXISTS', 'A time record exists in this range', { punchRecordId: punch.id });

  // overlapping absences: free-day markers are replaced, everything else blocks
  const overlapping = await trx
    .selectFrom('time_off')
    .selectAll()
    .where('employee_id', '=', emp.employee_id)
    .where('status', 'in', ['approved', 'pending'])
    .where('end_date', '>=', input.from)
    .where('start_date', '<=', input.to)
    .execute();
  const blocking = overlapping.filter((o) => o.type !== 'off_day' || input.type === 'off_day');
  if (blocking.length)
    throw new AppError('RULE_BLOCKED', 'The employee already has an absence in this range', {
      violations: [
        {
          code: 'ABSENCE_OVERLAP',
          severity: 'block',
          message: 'Overlapping absence',
          details: { timeOffId: blocking[0].id },
        },
      ],
    });

  const holidays = new Set((await resolveHolidays(trx, emp.primary_hotel_id, input.from, input.to)).keys());
  const counted = countedDays(input.from, input.to, contract.workingWeekdays, holidays);
  if (input.halfDay) {
    if (input.from !== input.to || input.type !== 'annual_leave')
      throw new AppError('VALIDATION', 'A half day is a single day of annual leave');
    if (!counted.length) throw new AppError('VALIDATION', 'The day is not a working day');
  }
  const dayCount = input.halfDay ? 0.5 : counted.length;
  const type = await trx
    .selectFrom('absence_type')
    .selectAll()
    .where('code', '=', input.type)
    .executeTakeFirstOrThrow();
  if (type.counts_against_allowance && counted.length === 0)
    throw new AppError('VALIDATION', 'The range contains no working days');

  // vacation allowance
  const perYear = yearsOf(input.halfDay ? counted.map((d) => d) : counted);
  if (input.halfDay) for (const k of perYear.keys()) perYear.set(k, 0.5);
  const violations: Array<{
    code: string;
    severity: 'needs_reason';
    message: string;
    details: Record<string, unknown>;
  }> = [];
  if (input.type === 'annual_leave')
    violations.push(
      ...(await leaveLimitIssues(trx, emp.employee_id, input.from, input.to, counted)).map((x) => ({
        ...x,
        severity: 'needs_reason' as const,
      })),
    );
  const allowances = new Map<number, Awaited<ReturnType<typeof ensureAllowance>>>();
  if (type.counts_against_allowance) {
    for (const [year, days] of perYear) {
      const a = await ensureAllowance(trx, emp.employee_id, year);
      allowances.set(year, a);
      if (remainingDays(a) < days)
        violations.push({
          code: 'VACATION_EXCEEDS',
          severity: 'needs_reason' as const,
          message: 'Planned vacation exceeds the remaining allowance',
          details: { year, remaining: remainingDays(a), days },
        });
    }
  }
  if (type.salary_only) {
    const ledger = await buildLedger(trx, emp.employee_id, today);
    if (!ledger)
      throw new AppError('VALIDATION', 'This absence type is only for employees with a time account');
    if (input.type === 'comp_time') {
      const weekly =
        contract.weeklyTarget ?? (contract.monthlyTarget != null ? (contract.monthlyTarget * 12) / 52 : 0);
      const daily = contract.dailyTarget ?? weekly / Math.max(1, contract.workingWeekdays.length);
      const after = Math.round((ledger.balanceHours - daily * counted.length) * 100) / 100;
      if (after < 0)
        violations.push({
          code: 'COMP_TIME_EXCEEDS',
          severity: 'needs_reason',
          message: 'The time account would become negative',
          details: { balanceHours: ledger.balanceHours, afterHours: after },
        });
    }
  }
  const enforced = enforce(violations, p, { overrideReason: input.overrideReason });

  // carve free-day markers out of the new range
  for (const o of overlapping.filter((x) => x.type === 'off_day'))
    await carveOffDay(trx, ctx.now, o, input.from, input.to, p.userId);

  const row = await trx
    .insertInto('time_off')
    .values({
      employee_id: emp.employee_id,
      start_date: input.from,
      end_date: input.to,
      time_off_days: dayCount,
      half_day: input.halfDay ?? null,
      type: input.type,
      reason: input.reason ?? null,
      status: 'approved',
      certificate_status: input.type === 'sick_leave' ? (input.certificateStatus ?? 'pending') : null,
      backdate_override_reason: backdateReason,
      counts_against_allowance: type.counts_against_allowance,
      credits_hours: type.credits_hours,
      created_by_user_id: p.userId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  // cancel overlapping schedule entries (a half day leaves the day's entries in place)
  const cancelled = input.halfDay
    ? []
    : await trx
        .updateTable('schedule')
        .set((eb) => ({
          status: 'cancelled',
          cancel_reason: input.type === 'sick_leave' ? 'sick' : 'changed',
          time_off_id: row.id,
          version: eb('version', '+', 1),
          updated_at: ctx.now,
        }))
        .where('employee_id', '=', emp.employee_id)
        .where('status', '<>', 'cancelled')
        .where('shift_date', '>=', input.from)
        .where('shift_date', '<=', input.to)
        .returning(['id', 'hotel_id', 'shift_date', 'published_at'])
        .execute();
  const publishedCancelled = cancelled.filter((c) => c.published_at);
  if (publishedCancelled.length) {
    await notifyEmployee(trx, { id: emp.employee_id, userId: emp.user_id }, 'schedule_changed', {
      entryIds: publishedCancelled.map((c) => c.id),
      change: 'removed',
      reason: input.type,
    });
  }

  if (type.counts_against_allowance) {
    for (const [year, days] of perYear) {
      const a = allowances.get(year)!;
      await trx
        .updateTable('employee_vacation_allowance')
        .set({ used_days: a.used_days + days, updated_at: ctx.now })
        .where('id', '=', a.id)
        .execute();
    }
  }
  await audit(trx, ctx.actor, {
    action: 'absence_created',
    entityType: 'time_off',
    entityId: row.id,
    hotelId: emp.primary_hotel_id,
    companyId: emp.company_id,
    new: {
      employeeId: emp.employee_id,
      type: input.type,
      from: input.from,
      to: input.to,
      days: dayCount,
      cancelledEntries: cancelled.length,
    },
    reason: backdateReason ?? input.overrideReason,
  });
  if (enforced.needsReason.length)
    await audit(trx, ctx.actor, {
      action: 'rule_override',
      entityType: 'time_off',
      entityId: row.id,
      hotelId: emp.primary_hotel_id,
      companyId: emp.company_id,
      reason: input.overrideReason,
      new: { codes: enforced.needsReason.map((v) => v.code) },
    });
  return {
    absenceId: row.id,
    days: dayCount,
    cancelledEntries: cancelled.length,
    warnings: enforced.warnings,
  };
}

async function carveOffDay(
  trx: Trx,
  now: Date,
  o: Selectable<DB['time_off']>,
  from: string,
  to: string,
  userId: number,
) {
  const before = o.start_date < from;
  const after = o.end_date > to;
  if (!before && !after) {
    await trx.updateTable('schedule').set({ time_off_id: null }).where('time_off_id', '=', o.id).execute();
    await trx
      .updateTable('time_off')
      .set({ status: 'cancelled', updated_at: now })
      .where('id', '=', o.id)
      .execute();
    return;
  }
  if (before)
    await trx
      .updateTable('time_off')
      .set({ end_date: addDays(from, -1), updated_at: now })
      .where('id', '=', o.id)
      .execute();
  if (before && after) {
    await trx
      .insertInto('time_off')
      .values({
        employee_id: o.employee_id,
        start_date: addDays(to, 1),
        end_date: o.end_date,
        time_off_days: 0,
        type: 'off_day',
        status: 'approved',
        counts_against_allowance: false,
        credits_hours: false,
        created_by_user_id: userId,
      })
      .execute();
  } else if (after)
    await trx
      .updateTable('time_off')
      .set({ start_date: addDays(to, 1), updated_at: now })
      .where('id', '=', o.id)
      .execute();
}

/** Reverses an absence: restores the vacation allowance and the entries it cancelled, then cancels the row. */
export async function reverseAbsence(
  trx: Trx,
  now: Date,
  t: {
    id: number;
    employee_id: number;
    start_date: string;
    end_date: string;
    counts_against_allowance: boolean;
    status: string;
    half_day?: string | null;
  },
  emp: { employee_id: number; primary_hotel_id: number },
) {
  const env = await PlanEnv.create(trx, now, {
    employeeIds: [emp.employee_id],
    from: t.start_date,
    to: t.end_date,
  });
  const pe = env.employees.get(emp.employee_id)!;
  if (t.counts_against_allowance && t.status === 'approved') {
    const contract = env.contractAt(pe, t.start_date) ?? pe.contracts[0];
    const holidays = new Set(
      (await resolveHolidays(trx, emp.primary_hotel_id, t.start_date, t.end_date)).keys(),
    );
    const counted = countedDays(
      t.start_date,
      t.end_date,
      contract?.workingWeekdays ?? [1, 2, 3, 4, 5],
      holidays,
    );
    for (const [year, n] of yearsOf(counted)) {
      const days = t.half_day ? 0.5 : n;
      const a = await ensureAllowance(trx, emp.employee_id, year);
      await trx
        .updateTable('employee_vacation_allowance')
        .set({ used_days: Math.max(0, a.used_days - days), updated_at: now })
        .where('id', '=', a.id)
        .execute();
    }
  }
  const cancelled = await trx.selectFrom('schedule').selectAll().where('time_off_id', '=', t.id).execute();
  const restored: number[] = [];
  const notRestored: number[] = [];
  for (const c of cancelled) {
    const clash = await trx
      .selectFrom('schedule')
      .select('id')
      .where('employee_id', '=', c.employee_id)
      .where('status', '<>', 'cancelled')
      .where('planned_start', '<', c.planned_end)
      .where('planned_end', '>', c.planned_start)
      .limit(1)
      .executeTakeFirst();
    if (clash) {
      notRestored.push(c.id);
      await trx.updateTable('schedule').set({ time_off_id: null }).where('id', '=', c.id).execute();
      continue;
    }
    await trx
      .updateTable('schedule')
      .set({
        status: c.published_at ? 'published' : 'draft',
        cancel_reason: null,
        time_off_id: null,
        version: c.version + 1,
        updated_at: now,
      })
      .where('id', '=', c.id)
      .execute();
    restored.push(c.id);
  }
  await trx
    .updateTable('time_off')
    .set({ status: 'cancelled', updated_at: now })
    .where('id', '=', t.id)
    .execute();
  return { restored, notRestored };
}

export async function deleteAbsence(ctx: Ctx, id: number) {
  const { trx, principal: p } = ctx;
  const t = await trx.selectFrom('time_off').selectAll().where('id', '=', id).executeTakeFirst();
  if (!t || t.status === 'cancelled') throw notFound('Absence');
  const emp = await assertPlannerEmployee(trx, p, t.employee_id);
  const env = await PlanEnv.create(trx, ctx.now, {
    employeeIds: [emp.employee_id],
    from: t.start_date,
    to: t.end_date,
  });
  const pe = env.employees.get(emp.employee_id)!;
  const today = localDate(ctx.now, env.hotel(emp.primary_hotel_id).tz);
  await checkPast(trx, p, today, t.start_date, t.type, emp.company_id, 'removal');
  for (const d of eachDay(t.start_date, t.end_date))
    for (const h of pe.hotelIds)
      if (env.isClosed(h, d))
        throw new AppError('PERIOD_CLOSED', 'The payroll period is closed', { date: d });
  const { restored, notRestored } = await reverseAbsence(trx, ctx.now, t, emp);
  await audit(trx, ctx.actor, {
    action: 'absence_deleted',
    entityType: 'time_off',
    entityId: id,
    hotelId: emp.primary_hotel_id,
    companyId: emp.company_id,
    old: { employeeId: t.employee_id, type: t.type, from: t.start_date, to: t.end_date },
    new: { restored, notRestored },
  });
  return { restored: restored.length, notRestored: notRestored.length };
}
