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
