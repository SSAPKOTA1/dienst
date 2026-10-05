/**
 * Time zone helpers. They sit on the hot path of planning (every rule check converts instants to hotel-local days),
 * and date-fns-tz builds a new `Intl.DateTimeFormat` for every call, which made them the biggest cost of the schedule
 * grid. Here the zone's UTC offset is read once per quarter hour and zone (offsets only change on such boundaries) and
 * everything else is integer arithmetic.
 */
const QUARTER = 15 * 60_000;
const formats = new Map<string, Intl.DateTimeFormat>();
const offsets = new Map<string, number>();
const MAX_CACHED_OFFSETS = 20_000;

const formatter = (tz: string): Intl.DateTimeFormat => {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formats.set(tz, f);
  }
  return f;
};

/** UTC offset of a zone at an instant, in milliseconds (positive east of Greenwich). */
export function offsetMs(ms: number, tz: string): number {
  const bucket = Math.floor(ms / QUARTER);
  const key = `${tz}|${bucket}`;
  const hit = offsets.get(key);
  if (hit !== undefined) return hit;
  const at = bucket * QUARTER;
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(at)))
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  const off = asUtc - at;
  if (offsets.size >= MAX_CACHED_OFFSETS) offsets.clear();
  offsets.set(key, off);
  return off;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** The instant shifted so that its UTC fields read as the zone's wall clock. */
const wall = (d: Date, tz: string) => new Date(d.getTime() + offsetMs(d.getTime(), tz));

/** Hotel-local calendar date (YYYY-MM-DD) of an instant. */
export const localDate = (d: Date, tz: string): string => wall(d, tz).toISOString().slice(0, 10);
/** Hotel-local wall clock minutes since midnight of an instant. */
export const localMinutes = (d: Date, tz: string): number => {
  const w = wall(d, tz);
  return w.getUTCHours() * 60 + w.getUTCMinutes();
};
/**
 * Local date + HH:mm in a time zone -> UTC instant. A time that exists once maps to its instant; a repeated time (clocks
 * go back) takes the first occurrence and a time inside the spring gap is read with the larger (summer) offset, which
 * is what date-fns-tz does.
 */
export const zonedInstant = (dateIso: string, hhmm: string, tz: string): Date => {
  const wallMs = Date.UTC(
    Number(dateIso.slice(0, 4)),
    Number(dateIso.slice(5, 7)) - 1,
    Number(dateIso.slice(8, 10)),
    Number(hhmm.slice(0, 2)),
    Number(hhmm.slice(3, 5)),
  );
  const o1 = offsetMs(wallMs, tz);
  const o2 = offsetMs(wallMs - o1, tz);
  if (o1 === o2) return new Date(wallMs - o1);
  const valid = [o1, o2].filter((o) => offsetMs(wallMs - o, tz) === o);
  return new Date(wallMs - (valid.length === 1 ? valid[0]! : Math.max(o1, o2)));
};
/** ISO-8601 with the hotel's UTC offset, e.g. 2026-10-12T06:00:00+02:00 */
export const isoWithOffset = (d: Date, tz: string): string => {
  const off = offsetMs(d.getTime(), tz);
  const w = new Date(d.getTime() + off);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off) / 60_000;
  return `${w.toISOString().slice(0, 19)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};
export const toDateStr = (d: Date | string): string =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
