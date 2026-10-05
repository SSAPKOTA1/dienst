// Leave rules of the backlog build (blackouts, concurrent absence caps, wishes). Pure functions.
import type { Violation } from './checks';

export interface BlackoutRule {
  id: number;
  departmentId: number | null;
  from: string;
  to: string;
  reason: string | null;
  /** null = no vacation at all in the period */
  maxConcurrentAbsent: number | null;
}

export interface LimitInput {
  /** counted working days of the request */
  days: string[];
  departmentId: number;
  /** blackouts of the employee's hotel; those with another department are ignored */
  blackouts: BlackoutRule[];
  /** number of OTHER employees of the same department who are absent, per day */
  absentOthers: Record<string, number>;
  /** department default cap (null = unlimited) */
  departmentCap: number | null;
}

const needs = (code: string, message: string, details: Record<string, unknown>): Violation => ({
  code,
  severity: 'needs_reason',
  message,
  details,
});

/** Violations of blackout periods and concurrent-absence caps. Callers decide whether they block (employee requests) or need a reason (planners). */
export function absenceLimitIssues(i: LimitInput): Violation[] {
  const out: Violation[] = [];
  const hit = new Map<string, string[]>();
  const add = (key: string, day: string) => hit.set(key, [...(hit.get(key) ?? []), day]);
  const info = new Map<string, Violation>();
  for (const day of i.days) {
    for (const b of i.blackouts) {
      if (b.departmentId != null && b.departmentId !== i.departmentId) continue;
      if (b.from > day || b.to < day) continue;
      if (b.maxConcurrentAbsent == null) {
        const k = `BLACKOUT:${b.id}`;
        add(k, day);
        info.set(
          k,
          needs('BLACKOUT', 'No vacation allowed in this period', { blackoutId: b.id, reason: b.reason }),
        );
      } else if ((i.absentOthers[day] ?? 0) + 1 > b.maxConcurrentAbsent) {
        const k = `MAX_CONCURRENT:${b.id}`;
        add(k, day);
        info.set(
          k,
          needs('MAX_CONCURRENT', 'Too many colleagues are absent in this period', {
            blackoutId: b.id,
            reason: b.reason,
            max: b.maxConcurrentAbsent,
          }),
        );
      }
    }
    if (i.departmentCap != null && (i.absentOthers[day] ?? 0) + 1 > i.departmentCap) {
      add('MAX_CONCURRENT:dept', day);
      info.set(
        'MAX_CONCURRENT:dept',
        needs('MAX_CONCURRENT', 'Too many colleagues of the department are absent', { max: i.departmentCap }),
      );
    }
  }
  for (const [k, v] of info) out.push({ ...v, details: { ...v.details, dates: hit.get(k) } });
  return out;
}

export interface ShiftWishRule {
  date: string;
  shiftId: number;
  priority: number;
}
export interface LeaveWishRule {
  from: string;
  to: string;
  priority: number;
}

/** "Widerspricht Wunsch": an entry that contradicts an open or granted wish of the employee (warning only). */
export function wishConflicts(
  entry: { localDate: string; shiftId: number | null },
  shiftWishes: ShiftWishRule[],
  leaveWishes: LeaveWishRule[],
): Violation[] {
  const out: Violation[] = [];
  const leave = leaveWishes.find((w) => w.from <= entry.localDate && w.to >= entry.localDate);
  if (leave)
    out.push({
      code: 'WISH_CONFLICT',
      severity: 'warn',
      message: 'Contradicts a leave wish of the employee',
      details: { kind: 'leave', date: entry.localDate, priority: leave.priority },
    });
  const same = shiftWishes.filter((w) => w.date === entry.localDate);
  if (same.length && !same.some((w) => w.shiftId === entry.shiftId))
    out.push({
      code: 'WISH_CONFLICT',
      severity: 'warn',
      message: 'Contradicts a shift wish of the employee',
      details: { kind: 'shift', date: entry.localDate, priority: Math.min(...same.map((w) => w.priority)) },
    });
  return out;
}

// ---------------------------------------------------------------- availability and qualifications (backlog M12)
export interface AvailabilityRule {
  /** 1 = Monday ... 7 = Sunday */
  weekday: number;
  /** minutes since midnight */
  fromMin: number;
  toMin: number;
  kind: 'unavailable' | 'preferred';
  validFrom: string;
  validTo: string | null;
  note?: string | null;
}

const isoWd = (iso: string): number => {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};
const nextDay = (iso: string): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/** Entries that run into a window of "cannot work" need a reason (`UNAVAILABLE`). A window past midnight is checked on the next day too. */
export function availabilityConflicts(
  entry: { localDate: string; startLocalMin: number; endLocalMin: number },
  windows: AvailabilityRule[],
): Violation[] {
  const pieces: Array<{ date: string; from: number; to: number }> = [
    { date: entry.localDate, from: entry.startLocalMin, to: Math.min(entry.endLocalMin, 1440) },
  ];
  if (entry.endLocalMin > 1440)
    pieces.push({ date: nextDay(entry.localDate), from: 0, to: entry.endLocalMin - 1440 });
  const out: Violation[] = [];
  for (const p of pieces)
    for (const w of windows) {
      if (w.kind !== 'unavailable' || w.weekday !== isoWd(p.date)) continue;
      if (w.validFrom > p.date || (w.validTo != null && w.validTo < p.date)) continue;
      if (Math.min(p.to, w.toMin) - Math.max(p.from, w.fromMin) <= 0) continue;
      out.push({
        code: 'UNAVAILABLE',
        severity: 'needs_reason',
        message: 'The employee marked this time as unavailable',
        details: { date: p.date, from: w.fromMin, to: w.toMin, note: w.note ?? null },
      });
    }
  return out;
}

/** A shift may require a qualification; a missing or expired one is a warning. */
export function qualificationIssue(
  requiredId: number | null | undefined,
  held: Array<{ id: number; validUntil: string | null }>,
  onDate: string,
): Violation[] {
  if (!requiredId) return [];
  const q = held.find((h) => h.id === requiredId);
  if (q && (q.validUntil == null || q.validUntil >= onDate)) return [];
  return [
    {
      code: 'QUALIFICATION_MISSING',
      severity: 'warn',
      message: q ? 'The qualification has expired' : 'The employee lacks the required qualification',
      details: { qualificationId: requiredId, expired: !!q, validUntil: q?.validUntil ?? null },
    },
  ];
}
