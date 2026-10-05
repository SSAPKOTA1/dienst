// Hour categories, rest-period compensation, Sunday / night-work statistics. Pure functions: callers split instants into
// hotel-local day segments, so nothing here knows about time zones.
import { addDays, isoWeekday } from './basics';
import { DEFAULT_LIMITS, type RuleLimits } from './profile';

// ---------------------------------------------------------------- hour categories (payroll minutes, never wages)
export type CategoryRule =
  | { daily: { from: string; to: string } }
  | { weekday: number }
  | { holiday: true }
  | { dates: string[]; from: string; to: string };

export interface HourCategory {
  code: string;
  rule: CategoryRule;
}

/** One hotel-local calendar-day piece of a worked window: minutes since local midnight, 0..1440. */
export interface DaySegment {
  date: string;
  fromMin: number;
  toMin: number;
}

const hm = (s: string): number => {
  const [h, m] = s.split(':').map(Number) as [number, number];
  return h * 60 + m;
};
const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Minutes of the window that fall into each category. Categories may overlap (a Sunday night counts for both). */
export function categoryMinutes(
  segments: DaySegment[],
  categories: HourCategory[],
  holidays: ReadonlySet<string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const seg of segments) {
    for (const c of categories) {
      let m = 0;
      const r = c.rule;
      if ('daily' in r) {
        const from = hm(r.daily.from);
        const to = hm(r.daily.to);
        m =
          from <= to
            ? overlap(seg.fromMin, seg.toMin, from, to)
            : overlap(seg.fromMin, seg.toMin, 0, to) + overlap(seg.fromMin, seg.toMin, from, 1440);
      } else if ('weekday' in r) {
        if (isoWeekday(seg.date) === r.weekday) m = seg.toMin - seg.fromMin;
      } else if ('holiday' in r) {
        if (holidays.has(seg.date)) m = seg.toMin - seg.fromMin;
      } else if ('dates' in r) {
        if (r.dates.includes(seg.date.slice(5))) m = overlap(seg.fromMin, seg.toMin, hm(r.from), hm(r.to));
      }
      if (m > 0) out[c.code] = (out[c.code] ?? 0) + m;
    }
  }
  return out;
}

export const DEFAULT_CATEGORIES: Array<HourCategory & { name: string }> = [
  { code: 'night', name: 'Nachtarbeit (23-6 Uhr)', rule: { daily: { from: '23:00', to: '06:00' } } },
  { code: 'sunday', name: 'Sonntagsarbeit', rule: { weekday: 7 } },
  { code: 'holiday', name: 'Feiertagsarbeit', rule: { holiday: true } },
  {
    code: 'special_eve',
    name: 'Heiligabend / Silvester ab 14 Uhr',
    rule: { dates: ['12-24', '12-31'], from: '14:00', to: '24:00' },
  },
];

/** Validates a category rule coming from the admin UI; returns an error message or null. */
export function validateCategoryRule(r: unknown): string | null {
  if (!r || typeof r !== 'object') return 'rule must be an object';
  const o = r as Record<string, unknown>;
  const time = (s: unknown) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(s);
  const keys = ['daily', 'weekday', 'holiday', 'dates'].filter((k) => k in o);
  if (keys.length !== 1) return 'exactly one of daily, weekday, holiday, dates';
  if ('daily' in o)
    return time((o.daily as { from?: unknown } | null)?.from) &&
      time((o.daily as { to?: unknown } | null)?.to)
      ? null
      : 'daily needs from and to as HH:mm';
  if ('weekday' in o)
    return typeof o.weekday === 'number' && Number.isInteger(o.weekday) && o.weekday >= 1 && o.weekday <= 7
      ? null
      : 'weekday 1-7';
  if ('holiday' in o) return o.holiday === true ? null : 'holiday must be true';
  if (
    !Array.isArray(o.dates) ||
    !o.dates.length ||
    !o.dates.every((d: unknown) => typeof d === 'string' && /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(d))
  )
    return 'dates as MM-DD list';
  return time(o.from) && time(o.to) ? null : 'dates needs from and to as HH:mm';
}

// ---------------------------------------------------------------- rest-period compensation (ArbZG § 5 Abs. 2)
export interface Shift {
  startMs: number;
  endMs: number;
}
export interface RestCompensation {
  /** end of the shift before the shortened rest and start of the next one */
  shortenedFromMs: number;
  shortenedToMs: number;
  gapMinutes: number;
  /** end of the 4 week window in which a rest of at least 12 hours must follow */
  dueMs: number;
  compensatedByMs: number | null;
  status: 'ok' | 'open' | 'overdue';
}

const WEEK = 7 * 86400000;

/**
 * Hospitality may cut the 11 h rest by up to 1 h if another rest of at least 12 h follows within four weeks. Lists every
 * shortened rest (10 h <= gap < 11 h) with its compensation. Rests below 10 h are blocked elsewhere and not listed.
 */
export function restCompensations(
  shifts: Shift[],
  nowMs: number,
  limits: RuleLimits = DEFAULT_LIMITS,
): RestCompensation[] {
  const s = [...shifts].sort((a, b) => a.startMs - b.startMs);
  const gaps = s
    .slice(1)
    .map((n, i) => ({ fromMs: s[i]!.endMs, toMs: n.startMs, minutes: (n.startMs - s[i]!.endMs) / 60000 }));
  const out: RestCompensation[] = [];
  for (const g of gaps) {
    if (g.minutes < limits.restBlockMinutes || g.minutes >= limits.restWarnMinutes) continue;
    const dueMs = g.toMs + 4 * WEEK;
    const comp = gaps.find((x) => x.fromMs >= g.toMs && x.fromMs <= dueMs && x.minutes >= 720);
    out.push({
      shortenedFromMs: g.fromMs,
      shortenedToMs: g.toMs,
      gapMinutes: g.minutes,
      dueMs,
      compensatedByMs: comp ? comp.fromMs : null,
      status: comp ? 'ok' : nowMs > dueMs ? 'overdue' : 'open',
    });
  }
  return out;
}

// ---------------------------------------------------------------- Sunday and night work (ArbZG §§ 6, 11)
export const sundaysInYear = (year: number): number => {
  let n = 0;
  for (let d = `${year}-01-01`; d <= `${year}-12-31`; d = addDays(d, 1)) if (isoWeekday(d) === 7) n++;
  return n;
};

/** Night minutes of a local window (minutes since midnight of the start date, end may exceed 1440): 23:00-06:00. */
export const nightMinutesOf = (startLocalMin: number, endLocalMin: number): number =>
  overlap(startLocalMin, endLocalMin, 0, 360) +
  overlap(startLocalMin, endLocalMin, 1380, 1800) +
  overlap(startLocalMin, endLocalMin, 2820, 3240);

/** A "night" for the night-worker rule: at least two hours of work between 23:00 and 06:00. */
export const isNightWork = (startLocalMin: number, endLocalMin: number): boolean =>
  nightMinutesOf(startLocalMin, endLocalMin) >= 120;
