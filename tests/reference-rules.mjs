export const requiredBreakMinutes = (g) => g <= 360 ? 0 : g <= 390 ? g - 360 : g <= 570 ? 30 : 45;
export const paidHours = (g, b) => Math.round(((g - b) / 60) * 100) / 100;
export const variationMinutes = (actualIso, plannedIso) => Math.trunc((Date.parse(actualIso) - Date.parse(plannedIso)) / 60000);
export const withinGrace = (v, grace = 15) => Math.abs(v) <= grace;
export function proratedVacationDays(annual, startIso, year) {
  const [y, m, d] = startIso.split('-').map(Number);
  if (y < year) return annual;
  if (y > year) return 0;
  if (m < 7 || (m === 7 && d === 1)) return annual;
  const fullMonths = d === 1 ? 12 - m + 1 : 12 - m;
  return Math.floor((annual * fullMonths) / 12 + 0.5);
}
export const restPeriodResult = (gapMin) => gapMin < 600 ? 'blocked' : gapMin < 660 ? 'needs_reason' : 'ok';
export const dailyLimitResult = (workMin) => workMin > 600 ? 'blocked' : workMin > 480 ? 'warn' : 'ok';
export const durationMinutes = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;
export const displayName = (f, l) => `${f} ${l.charAt(0)}.`;
export const sickBackdateAllowed = (todayIso, dayIso, limit = 7) => (Date.parse(todayIso) - Date.parse(dayIso)) / 86400000 <= limit;
export const openSlots = (required, assigned) => Math.max(0, required - assigned);
export const usernameBase = (first, last) => {
  const t = (x) => x.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  return `${t(first)}.${t(last)}`;
};
export const nextUsername = (base, taken) => {
  if (!taken.has(base)) return base;
  let n = 2; while (taken.has(base + n)) n++; return base + n;
};
export function timeAccountBalance({ opening = 0, monthlyTarget, startIso, asOfIso, approvedPaidHours, creditHours, unpaidDays = 0, dailyTarget = 0 }) {
  const start = new Date(startIso + 'T00:00:00Z');
  const end = new Date(asOfIso + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() - 1);   // asOf is exclusive
  let target = 0;
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); new Date(Date.UTC(y, m, 1)) <= end; ) {
    const first = new Date(Date.UTC(y, m, 1));
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const last = new Date(Date.UTC(y, m, dim));
    const a = start > first ? start : first, b = end < last ? end : last;
    if (b >= a) target += (monthlyTarget * (Math.round((b - a) / 86400000) + 1)) / dim;
    m++; if (m > 11) { m = 0; y++; }
  }
  target -= dailyTarget * unpaidDays;
  return Math.round((opening + approvedPaidHours + creditHours - target) * 100) / 100;
}
