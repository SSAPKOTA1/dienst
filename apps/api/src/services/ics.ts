/** Minimal RFC 5545 writer for the calendar subscription: timed events in UTC, all-day absences, escaped and folded lines. */
export interface IcsEvent {
  uid: string;
  summary: string;
  location?: string;
  start?: Date;
  end?: Date;
  allDay?: { from: string; to: string };
  sequence?: number;
}

const esc = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const utc = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const day = (iso: string) => iso.replace(/-/g, '');
const nextDay = (iso: string) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/** Lines are folded at 75 octets with a leading space on the continuation (CRLF line ends). */
export function fold(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.map((l, i) => (i ? ` ${l}` : l));
}

export function icsCalendar(c: { name: string; events: IcsEvent[] }): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dienst//Dienstplan//DE',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${esc(c.name)}`,
  ];
  const stamp = utc(new Date());
  for (const e of c.events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `SEQUENCE:${e.sequence ?? 0}`,
      `SUMMARY:${esc(e.summary)}`,
    );
    if (e.allDay)
      lines.push(`DTSTART;VALUE=DATE:${day(e.allDay.from)}`, `DTEND;VALUE=DATE:${day(nextDay(e.allDay.to))}`);
    else lines.push(`DTSTART:${utc(e.start!)}`, `DTEND:${utc(e.end!)}`);
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.flatMap(fold).join('\r\n') + '\r\n';
}
