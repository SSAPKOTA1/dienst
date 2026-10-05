import { describe, expect, it } from 'vitest';
import { formatInTimeZone } from 'date-fns-tz';
import { fromZonedTime } from 'date-fns-tz';
import { isoWithOffset, localDate, localMinutes, offsetMs, zonedInstant } from '../src/lib/time';

const ZONES = ['Europe/Berlin', 'UTC', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe'];

describe('fast time zone helpers agree with date-fns-tz', () => {
  it('local date, minutes and ISO with offset for every 7 minutes across three years incl. all DST changes', () => {
    const from = Date.UTC(2025, 0, 1);
    const to = Date.UTC(2028, 0, 1);
    for (const tz of ZONES) {
      for (let t = from; t < to; t += 7 * 60_000 + 13_000) {
        const d = new Date(t);
        const [h, m] = formatInTimeZone(d, tz, 'HH:mm').split(':').map(Number);
        if (localDate(d, tz) !== formatInTimeZone(d, tz, 'yyyy-MM-dd'))
          throw new Error(`date ${tz} ${d.toISOString()}`);
        if (localMinutes(d, tz) !== h! * 60 + m!) throw new Error(`minutes ${tz} ${d.toISOString()}`);
        if (isoWithOffset(d, tz) !== formatInTimeZone(d, tz, "yyyy-MM-dd'T'HH:mm:ssxxx"))
          throw new Error(`iso ${tz} ${d.toISOString()} ${isoWithOffset(d, tz)}`);
      }
    }
  }, 120_000);
  it('turns local wall clock times into the same instants as date-fns-tz, including around DST changes', () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const diffs: string[] = [];
    for (const tz of ZONES) {
      for (let day = Date.UTC(2025, 0, 1); day < Date.UTC(2028, 0, 1); day += 86_400_000) {
        const date = new Date(day).toISOString().slice(0, 10);
        for (let min = 0; min < 1440; min += 30) {
          const hhmm = `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
          const a = zonedInstant(date, hhmm, tz).getTime();
          const b = fromZonedTime(`${date}T${hhmm}:00`, tz).getTime();
          if (a !== b) diffs.push(`${tz} ${date} ${hhmm}`);
        }
      }
    }
    expect(diffs.slice(0, 5)).toEqual([]);
  }, 300_000);
  it('knows the Berlin offset in summer and winter', () => {
    expect(offsetMs(Date.UTC(2026, 6, 1), 'Europe/Berlin')).toBe(2 * 3600_000);
    expect(offsetMs(Date.UTC(2026, 0, 1), 'Europe/Berlin')).toBe(3600_000);
  });
  it('handles the Berlin day of the spring change (23 h) and of the autumn change (25 h)', () => {
    expect(localDate(new Date('2026-03-28T23:30:00Z'), 'Europe/Berlin')).toBe('2026-03-29');
    expect(localMinutes(new Date('2026-03-29T01:00:00Z'), 'Europe/Berlin')).toBe(3 * 60); // 02:00 does not exist
    expect(localMinutes(new Date('2026-10-25T00:30:00Z'), 'Europe/Berlin')).toBe(2 * 60 + 30);
    expect(localMinutes(new Date('2026-10-25T01:30:00Z'), 'Europe/Berlin')).toBe(2 * 60 + 30); // the second 02:30
  });
});
