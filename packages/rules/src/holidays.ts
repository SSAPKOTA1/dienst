// German public holidays (Feiertage) per federal state. Pure: dates come from the year alone.
import { addDays, isoWeekday } from './basics';

export const FEDERAL_STATE_CODES = [
  'BW',
  'BY',
  'BE',
  'BB',
  'HB',
  'HH',
  'HE',
  'MV',
  'NI',
  'NW',
  'RP',
  'SL',
  'SN',
  'ST',
  'SH',
  'TH',
] as const;
export type FederalStateCode = (typeof FEDERAL_STATE_CODES)[number];

export interface HolidayDef {
  scope: 'national' | 'state';
  state?: FederalStateCode;
  date: string;
  name: string;
}

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

/** Buß- und Bettag: the Wednesday before 23 November. */
export const bussUndBettag = (year: number): string => {
  const nov22 = `${year}-11-22`;
  return addDays(nov22, -((isoWeekday(nov22) - 3 + 7) % 7));
};

/**
 * National holidays plus the state holidays of all 16 federal states for one year.
 * Not covered on purpose: holidays that apply only in parts of a state (Mariä Himmelfahrt in Bavaria,
 * Augsburger Friedensfest, Fronleichnam in some Saxon and Thuringian communities). A company or hotel
 * entry (POST /holidays) adds those.
 */
export function holidaysFor(year: number): HolidayDef[] {
  const e = easter(year);
  const nat = (date: string, name: string): HolidayDef => ({ scope: 'national', date, name });
  const st = (states: FederalStateCode[], date: string, name: string): HolidayDef[] =>
    states.map((state) => ({ scope: 'state', state, date, name }));
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
    ...st(['BW', 'BY', 'ST'], `${year}-01-06`, 'Heilige Drei Könige'),
    ...st(['BE', 'MV'], `${year}-03-08`, 'Internationaler Frauentag'),
    ...st(['BB'], e, 'Ostersonntag'),
    ...st(['BB'], addDays(e, 49), 'Pfingstsonntag'),
    ...st(['BW', 'BY', 'HE', 'NW', 'RP', 'SL'], addDays(e, 60), 'Fronleichnam'),
    ...st(['SL'], `${year}-08-15`, 'Mariä Himmelfahrt'),
    ...st(['TH'], `${year}-09-20`, 'Weltkindertag'),
    ...st(['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH'], `${year}-10-31`, 'Reformationstag'),
    ...st(['BW', 'BY', 'NW', 'RP', 'SL'], `${year}-11-01`, 'Allerheiligen'),
    ...st(['SN'], bussUndBettag(year), 'Buß- und Bettag'),
  ];
}
