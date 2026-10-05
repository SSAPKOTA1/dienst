import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/** Hotel-local calendar date (YYYY-MM-DD) of an instant. */
export const localDate = (d: Date, tz: string): string => formatInTimeZone(d, tz, 'yyyy-MM-dd');
/** Hotel-local wall clock minutes since midnight of an instant. */
export const localMinutes = (d: Date, tz: string): number => {
  const [h, m] = formatInTimeZone(d, tz, 'HH:mm').split(':').map(Number);
  return h * 60 + m;
};
/** Local date + HH:mm in a time zone -> UTC instant (DST safe). */
export const zonedInstant = (dateIso: string, hhmm: string, tz: string): Date =>
  fromZonedTime(`${dateIso}T${hhmm}:00`, tz);
/** ISO-8601 with the hotel's UTC offset, e.g. 2026-10-12T06:00:00+02:00 */
export const isoWithOffset = (d: Date, tz: string): string =>
  formatInTimeZone(d, tz, "yyyy-MM-dd'T'HH:mm:ssxxx");
export const toDateStr = (d: Date | string): string =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
