// Planning rule checks (SPEC 4.3). Pure: callers load the data, nothing here reads a clock or a database.
import { isoWeekday } from './basics';
import { DEFAULT_LIMITS, type RuleLimits } from './profile';
import { isNightWork, sundaysInYear } from './hours';
import { ageOn, overlapsNightWindow } from './minors';
import {
  availabilityConflicts,
  qualificationIssue,
  wishConflicts,
  type AvailabilityRule,
  type LeaveWishRule,
  type ShiftWishRule,
} from './leave';

export type Severity = 'block' | 'needs_reason' | 'warn';

export interface Violation {
  code: string;
  severity: Severity;
  message: string;
  details: Record<string, unknown>;
}

export interface RuleOther {
  id: number | null;
  startMs: number;
  endMs: number;
  breakMinutes: number;
  /** hotel-local start date (shift_date) */
  localDate: string;
}

export interface CheckInput {
  entry: {
    id?: number | null;
    hotelId: number;
    departmentId: number | null;
    shiftId?: number | null;
    startMs: number;
    endMs: number;
    breakMinutes: number;
    localDate: string;
    /** hotel-local minutes since midnight of localDate at start and end (end may exceed 1440) */
    startLocalMin: number;
    endLocalMin: number;
  };
  employee: { dateOfBirth: string; active: boolean; hotelIds: number[]; departmentIds: number[] };
  contractActive: boolean;
  monthlyHoursCap: number | null;
  /** the employee's other non-cancelled entries (all hotels), without the entry itself */
  others: RuleOther[];
  absenceOnDay: boolean;
  periodClosed: boolean;
  /** hotel-local today */
  today: string;
  /** open or granted wishes of the employee (backlog); optional so the v1 vectors stay unchanged */
  wishes?: { shift: ShiftWishRule[]; leave: LeaveWishRule[] };
  /** recurring windows of the employee (backlog) */
  availability?: AvailabilityRule[];
  /** qualification required by the shift and the ones the employee holds (backlog) */
  qualification?: { requiredId: number | null; held: Array<{ id: number; validUntil: string | null }> };
  /** limits of the company / hotel rule profile (stricter than the statutory defaults only) */
  limits?: Partial<RuleLimits>;
  /** Sunday and night statistics of the employee from all other entries (backlog) */
  calendar?: {
    /** distinct local dates of other entries that start on a Sunday in the same calendar year */
    sundayDates: string[];
    /** distinct local dates of other night entries in the 12 months before the entry */
    nightDates: string[];
  };
  /** codes to skip, e.g. PAST_DAY when only warnings of existing entries are wanted */
  skip?: string[];
}

export const workingMinutes = (e: { startMs: number; endMs: number; breakMinutes: number }): number =>
  (e.endMs - e.startMs) / 60000 - e.breakMinutes;

const v = (
  code: string,
  severity: Severity,
  message: string,
  details: Record<string, unknown> = {},
): Violation => ({
  code,
  severity,
  message,
  details,
});

export function checkEntry(i: CheckInput): Violation[] {
  const out: Violation[] = [];
  const e = i.entry;
  const skip = new Set(i.skip ?? []);
  const add = (x: Violation) => {
    if (!skip.has(x.code)) out.push(x);
  };

  // --- hard conditions
  for (const o of i.others) {
    if (o.startMs < e.endMs && o.endMs > e.startMs)
      add(v('OVERLAP', 'block', 'Overlaps another entry of this employee', { entryId: o.id }));
  }
  if (e.localDate < i.today) add(v('PAST_DAY', 'block', 'The day is in the past', { date: e.localDate }));
  if (i.periodClosed) add(v('PERIOD_CLOSED', 'block', 'The payroll period is closed', { date: e.localDate }));
  if (!i.employee.hotelIds.includes(e.hotelId))
    add(v('NOT_AT_HOTEL', 'block', 'The employee does not work at this hotel', { hotelId: e.hotelId }));
  if (e.departmentId != null && !i.employee.departmentIds.includes(e.departmentId))
    add(
      v('WRONG_DEPARTMENT', 'block', 'The employee does not belong to this department', {
        departmentId: e.departmentId,
      }),
    );
  if (i.absenceOnDay)
    add(v('ABSENCE_CONFLICT', 'block', 'The employee is absent on this day', { date: e.localDate }));
  if (!i.contractActive || !i.employee.active)
    add(v('CONTRACT_INACTIVE', 'block', 'No active contract on this date', { date: e.localDate }));

  const lim = { ...DEFAULT_LIMITS, ...(i.limits ?? {}) };
  const minor = ageOn(i.employee.dateOfBirth, e.localDate) < 18;

  // --- daily working time (all entries of the same local start date)
  const sameDay = i.others.filter((o) => o.localDate === e.localDate);
  const dayMin = workingMinutes(e) + sameDay.reduce((a, o) => a + workingMinutes(o), 0);
  if (dayMin > lim.dailyMaxMinutes)
    add(v('DAILY_LIMIT', 'block', 'More than 10 hours of work on this day', { workMinutes: dayMin }));
  else if (dayMin > lim.dailyWarnMinutes)
    add(v('DAILY_OVER_8H', 'warn', 'More than 8 hours of work on this day', { workMinutes: dayMin }));
  if (minor && dayMin > lim.minorDailyMaxMinutes)
    add(v('MINOR_DAILY', 'block', 'Minors may work at most 8 hours per day', { workMinutes: dayMin }));
  if (minor && overlapsNightWindow(e.startLocalMin, e.endLocalMin))
    add(v('MINOR_NIGHT', 'block', 'Minors may not work between 20:00 and 06:00', { date: e.localDate }));

  // --- rest periods against neighbours on other days (a second entry on the same day is a split shift)
  const other = i.others.filter((o) => o.localDate !== e.localDate);
  const prev = other.filter((o) => o.endMs <= e.startMs).sort((a, b) => b.endMs - a.endMs)[0];
  const next = other.filter((o) => o.startMs >= e.endMs).sort((a, b) => a.startMs - b.startMs)[0];
  const sides: Array<['before' | 'after', RuleOther | undefined, number | null]> = [
    ['before', prev, prev ? (e.startMs - prev.endMs) / 60000 : null],
    ['after', next, next ? (next.startMs - e.endMs) / 60000 : null],
  ];
  for (const [side, n, gap] of sides) {
    if (!n || gap == null) continue;
    if (gap < lim.restBlockMinutes)
      add(v('REST_PERIOD', 'block', 'Rest period below 10 hours', { gapMinutes: gap, side, entryId: n.id }));
    else if (gap < lim.restWarnMinutes)
      add(
        v('REST_PERIOD', 'needs_reason', 'Rest period below 11 hours', {
          gapMinutes: gap,
          side,
          entryId: n.id,
        }),
      );
    if (minor && gap < lim.minorRestMinutes)
      add(
        v('MINOR_REST', 'block', 'Minors need a rest period of 12 hours', {
          gapMinutes: gap,
          side,
          entryId: n.id,
        }),
      );
  }

  // --- monthly cap (warning only)
  if (i.monthlyHoursCap != null) {
    const month = e.localDate.slice(0, 7);
    const planned =
      workingMinutes(e) +
      i.others.filter((o) => o.localDate.slice(0, 7) === month).reduce((a, o) => a + workingMinutes(o), 0);
    if (planned / 60 > i.monthlyHoursCap)
      add(
        v('MONTHLY_CAP', 'warn', 'Planned hours exceed the monthly cap', {
          plannedHours: Math.round((planned / 60) * 100) / 100,
          cap: i.monthlyHoursCap,
        }),
      );
  }
  if (i.calendar) {
    const year = Number(e.localDate.slice(0, 4));
    if (isoWeekday(e.localDate) === 7) {
      const worked = new Set([
        ...i.calendar.sundayDates.filter((d) => d.startsWith(String(year))),
        e.localDate,
      ]).size;
      const free = sundaysInYear(year) - worked;
      if (free < lim.sundaysFreeMin)
        add(
          v('SUNDAY_LIMIT', 'warn', 'Fewer than 15 Sundays off in this year', {
            freeSundays: free,
            required: lim.sundaysFreeMin,
          }),
        );
    }
    if (isNightWork(e.startLocalMin, e.endLocalMin)) {
      const nights = new Set([...i.calendar.nightDates, e.localDate]).size;
      if (nights >= lim.nightWorkerNights)
        add(
          v('NIGHT_WORKER', 'warn', 'The employee counts as night worker', {
            nights,
            from: lim.nightWorkerNights,
          }),
        );
    }
  }
  if (i.availability)
    for (const w of availabilityConflicts(
      { localDate: e.localDate, startLocalMin: e.startLocalMin, endLocalMin: e.endLocalMin },
      i.availability,
    ))
      add(w);
  if (i.qualification)
    for (const w of qualificationIssue(i.qualification.requiredId, i.qualification.held, e.localDate)) add(w);
  if (i.wishes)
    for (const w of wishConflicts(
      { localDate: e.localDate, shiftId: e.shiftId ?? null },
      i.wishes.shift,
      i.wishes.leave,
    ))
      add(w);
  return out;
}

export type Aggregate = 'ok' | 'needs_reason' | 'blocked';
export interface AggregateOptions {
  emergencyOverride?: boolean;
  role: 'superAdmin' | 'admin' | 'manager';
}

const OVERRIDABLE = new Set(['DAILY_LIMIT', 'MINOR_REST', 'REST_PERIOD']);

/**
 * Aggregates violations (SPEC 4.3). An emergency override by an admin or super admin downgrades DAILY_LIMIT,
 * MINOR_REST and REST_PERIOD (< 600 min) from block to needs_reason; everything else stays blocked.
 */
export function aggregate(violations: Violation[], opts: AggregateOptions) {
  const canOverride = !!opts.emergencyOverride && (opts.role === 'admin' || opts.role === 'superAdmin');
  const overridden: string[] = [];
  const list = violations.map((x) => {
    if (canOverride && x.severity === 'block' && OVERRIDABLE.has(x.code)) {
      overridden.push(x.code);
      return { ...x, severity: 'needs_reason' as Severity };
    }
    return x;
  });
  const status: Aggregate = list.some((x) => x.severity === 'block')
    ? 'blocked'
    : list.some((x) => x.severity === 'needs_reason')
      ? 'needs_reason'
      : 'ok';
  return { status, violations: list, overridden };
}

export const validOverrideReason = (r: string | null | undefined): boolean =>
  !!r && r.trim().length >= 5 && r.trim().length <= 300;
