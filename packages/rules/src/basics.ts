// Pure rule functions (SPEC 4.1). No IO, no Date.now. Must reproduce tests/vectors.json.

export const requiredBreakMinutes = (g: number): number =>
  g <= 360 ? 0 : g <= 390 ? g - 360 : g <= 570 ? 30 : 45; // ArbZG 4, net-time logic

export const paidHours = (g: number, b: number): number => Math.round(((g - b) / 60) * 100) / 100;

export const variationMinutes = (actualIso: string, plannedIso: string): number =>
  Math.trunc((Date.parse(actualIso) - Date.parse(plannedIso)) / 60000);

export const withinGrace = (v: number, grace = 15): boolean => Math.abs(v) <= grace;

export const restPeriodResult = (gapMin: number): 'blocked' | 'needs_reason' | 'ok' =>
  gapMin < 600 ? 'blocked' : gapMin < 660 ? 'needs_reason' : 'ok';

export const dailyLimitResult = (workMin: number): 'blocked' | 'warn' | 'ok' =>
  workMin > 600 ? 'blocked' : workMin > 480 ? 'warn' : 'ok';

export function proratedVacationDays(annual: number, startIso: string, year: number): number {
  const [y, m, d] = startIso.split('-').map(Number);
  if (y < year) return annual;
  if (y > year) return 0;
  if (m < 7 || (m === 7 && d === 1)) return annual; // waiting period completed in the year
  const fullMonths = d === 1 ? 12 - m + 1 : 12 - m;
  return Math.floor((annual * fullMonths) / 12 + 0.5); // round half up
}

export const displayName = (f: string, l: string): string => `${f} ${l.charAt(0)}.`;

export const openSlots = (required: number, assigned: number): number => Math.max(0, required - assigned);

export const usernameBase = (first: string, last: string): string => {
  const t = (x: string) =>
    x
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]/g, '');
  return `${t(first)}.${t(last)}`; // if a part is empty the caller falls back to 'user' + 6 digits
};

export const nextUsername = (base: string, taken: Set<string>): string => {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(base + n)) n++;
  return base + n;
};

export const durationMinutes = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 60000;

export const sickBackdateAllowed = (todayIso: string, dayIso: string, limit = 7): boolean =>
  (Date.parse(todayIso) - Date.parse(dayIso)) / 86400000 <= limit;

export function timeAccountBalance(p: {
  opening?: number;
  monthlyTarget: number;
  startIso: string;
  asOfIso: string;
  approvedPaidHours: number;
  creditHours: number;
  unpaidDays?: number;
  dailyTarget?: number;
}): number {
  const start = new Date(p.startIso + 'T00:00:00Z');
  const end = new Date(p.asOfIso + 'T00:00:00Z');
  end.setUTCDate(end.getUTCDate() - 1); // asOf is exclusive
  let target = 0;
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); new Date(Date.UTC(y, m, 1)) <= end;) {
    const first = new Date(Date.UTC(y, m, 1));
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const last = new Date(Date.UTC(y, m, dim));
    const a = start > first ? start : first;
    const b = end < last ? end : last;
    if (b >= a) target += (p.monthlyTarget * (Math.round((+b - +a) / 86400000) + 1)) / dim;
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  target -= (p.dailyTarget ?? 0) * (p.unpaidDays ?? 0);
  return Math.round(((p.opening ?? 0) + p.approvedPaidHours + p.creditHours - target) * 100) / 100;
}

/** PIN policy (SPEC 4.12): all-equal digits and straight ascending/descending runs are rejected. */
export function isWeakPin(pin: string): boolean {
  if (!/^\d+$/.test(pin)) return true;
  const d = pin.split('').map(Number);
  if (d.every((x) => x === d[0])) return true;
  const asc = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  const desc = d.every((x, i) => i === 0 || x === d[i - 1] - 1);
  return asc || desc;
}

// ---- date helpers on ISO strings (pure) ---------------------------------------------------
export const addDays = (iso: string, n: number): string => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** ISO weekday 1=Mon..7=Sun */
export const isoWeekday = (iso: string): number => {
  const d = new Date(iso + 'T00:00:00Z').getUTCDay();
  return d === 0 ? 7 : d;
};
export const mondayOf = (iso: string): string => addDays(iso, 1 - isoWeekday(iso));
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** SPEC 4.4: counted days = dates on the employee's working weekdays that are not public holidays. */
export function countedDays(
  from: string,
  to: string,
  workingWeekdays: number[],
  holidays: Set<string>,
): string[] {
  return eachDay(from, to).filter((d) => workingWeekdays.includes(isoWeekday(d)) && !holidays.has(d));
}
