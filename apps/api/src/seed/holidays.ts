import { addDays } from '@dienst/rules';

/** Easter Sunday (anonymous Gregorian algorithm). */
export function easter(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface HolidayDef {
  scope: 'national' | 'state';
  state?: string;
  date: string;
  name: string;
}

export function holidaysFor(year: number): HolidayDef[] {
  const e = easter(year);
  const nat = (date: string, name: string): HolidayDef => ({ scope: 'national', date, name });
  return [
    nat(`${year}-01-01`, 'Neujahr'),
    nat(addDays(e, -2), 'Karfreitag'),
    nat(addDays(e, 1), 'Ostermontag'),
    nat(`${year}-05-01`, 'Tag der Arbeit'),
    nat(addDays(e, 39), 'Christi Himmelfahrt'),
    nat(addDays(e, 50), 'Pfingstmontag'),
    nat(`${year}-10-03`, 'Tag der Deutschen Einheit'),
    nat(`${year}-12-25`, '1. Weihnachtstag'),
    nat(`${year}-12-26`, '2. Weihnachtstag'),
    { scope: 'state', state: 'HE', date: addDays(e, 60), name: 'Fronleichnam' },
    { scope: 'state', state: 'BE', date: `${year}-03-08`, name: 'Internationaler Frauentag' },
  ];
}
