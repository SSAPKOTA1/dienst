import { getISOWeek } from 'date-fns';
import type { TFunction } from 'i18next';
import i18n from '../../i18n';
import { fdate, fnum } from '../../lib/format';

/** local clock time of an instant in the hotel time zone */
export const hmTz = (iso: string, tz = 'Europe/Berlin'): string =>
  new Intl.DateTimeFormat('de-DE', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
export const addDaysIso = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const mondayOfIso = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  const wd = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  return addDaysIso(iso, 1 - wd);
};
export const todayIso = (tz = 'Europe/Berlin'): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
export const isoWeekNo = (iso: string): number => getISOWeek(new Date(`${iso}T12:00:00Z`));

export const DOW = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export const dowOf = (iso: string): number => {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d === 0 ? 6 : d - 1;
};
export const dayNum = (iso: string): number => Number(iso.slice(8, 10));

/** hour part of a local ISO string like 2026-10-12T06:00:00+02:00 */
export const hm = (iso: string): string => iso.slice(11, 16);
const short = (s: string): string => (s.endsWith(':00') ? s.slice(0, 2) : s);
/** "06–14" / "08–16:30" as in the prototype */
export const rangeLabel = (start: string, end: string): string => `${short(hm(start))}–${short(hm(end))}`;

export const weekRangeLabel = (from: string, to: string): string => {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat(i18n.language === 'en' ? 'en-GB' : 'de-DE', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
    }).format(d);
  return `${fmt(a)} – ${fmt(b)} ${b.getUTCFullYear()}`;
};

export const ABSENCE_LABEL: Record<string, string> = {
  annual_leave: 'Urlaub',
  vocational_school: 'Berufsschule',
  sick_leave: 'Krank',
  off_day: 'Frei',
  unpaid_leave: 'Unbezahlt frei',
  absent: 'Abwesend',
};

const MINOR_CODES = new Set(['MINOR_REST', 'MINOR_NIGHT', 'MINOR_DAILY']);

export interface Violation {
  code: string;
  severity: 'block' | 'needs_reason' | 'warn';
  message?: string;
  details?: Record<string, any>;
}

/** Title and message of a server violation in the UI language. */
export function violationText(v: Violation, t: TFunction): { title: string; msg: string } {
  const h = (min: unknown) => fnum(Math.round((Number(min) / 60) * 10) / 10);
  const d = v.details ?? {};
  switch (v.code) {
    case 'REST_PERIOD':
      return {
        title: t('Ruhezeit'),
        msg: `${t('Nur')} ${h(d.gapMinutes)} h ${t('Ruhezeit')} · ${t('mindestens 11 h')}`,
      };
    case 'MINOR_REST':
      return {
        title: t('Jugendarbeitsschutz'),
        msg: `${t('Ruhezeit')} · ${t('Grenze 12 h')} · ${t('tatsächlich')} ${h(d.gapMinutes)} h`,
      };
    case 'MINOR_NIGHT':
      return {
        title: t('Jugendarbeitsschutz'),
        msg: t('Minderjährige dürfen nicht zwischen 20:00 und 06:00 arbeiten.'),
      };
    case 'MINOR_DAILY':
      return {
        title: t('Jugendarbeitsschutz'),
        msg: t('Minderjährige dürfen höchstens 8 Stunden pro Tag arbeiten.'),
      };
    case 'DAILY_LIMIT':
      return {
        title: t('Arbeitszeit'),
        msg: `${h(d.workMinutes)} h ${t('an diesem Tag')} · ${t('Grenze 10 h')}`,
      };
    case 'DAILY_OVER_8H':
      return {
        title: t('Arbeitszeit'),
        msg: `${h(d.workMinutes)} h ${t('an diesem Tag')} · ${t('über 8 h')}`,
      };
    case 'OVERLAP':
      return { title: t('Überschneidung'), msg: t('Überschneidet sich mit einem anderen Eintrag.') };
    case 'PAST_DAY':
      return { title: t('Vergangen · gesperrt'), msg: t('Vergangener Tag. Keine Änderungen möglich.') };
    case 'PERIOD_CLOSED':
      return {
        title: t('Monat abgeschlossen'),
        msg: t('Der Zeitraum ist abgeschlossen. Keine Änderungen möglich.'),
      };
    case 'ABSENCE_CONFLICT':
      return { title: t('Abwesenheit'), msg: t('Die Person ist an diesem Tag abwesend.') };
    case 'NOT_AT_HOTEL':
      return { title: t('Anderes Hotel'), msg: t('Die Person ist diesem Hotel nicht zugeordnet.') };
    case 'WRONG_DEPARTMENT':
      return { title: t('Abteilung'), msg: t('Die Person gehört nicht zu dieser Abteilung.') };
    case 'CONTRACT_INACTIVE':
      return { title: t('Vertrag'), msg: t('Kein gültiger Vertrag an diesem Tag.') };
    case 'MONTHLY_CAP':
      return {
        title: t('Monatsgrenze'),
        msg: `${fnum(d.plannedHours)} h ${t('geplant')} · ${t('Grenze')} ${fnum(d.cap)} h`,
      };
    case 'VACATION_EXCEEDS':
      return {
        title: t('Resturlaub reicht nicht'),
        msg: `${t('Rest')} ${fnum(d.remaining)} · ${t('benötigt')} ${fnum(d.days)}`,
      };
    case 'SICK_BACKDATE':
      return { title: t('Vergangen · gesperrt'), msg: t('Zu weit in der Vergangenheit für Leitungen.') };
    case 'ABSENCE_OVERLAP':
      return { title: t('Abwesenheit'), msg: t('Es gibt bereits eine Abwesenheit in diesem Zeitraum.') };
    case 'WISH_CONFLICT':
      return {
        title: t('Widerspricht Wunsch'),
        msg:
          d.kind === 'leave'
            ? t('Es liegt ein Urlaubswunsch für diesen Tag vor.')
            : t('Es liegt ein anderer Schichtwunsch für diesen Tag vor.'),
      };
    case 'BLACKOUT':
      return { title: t('Sperrzeit'), msg: t('In diesem Zeitraum ist kein Urlaub vorgesehen.') };
    case 'MAX_CONCURRENT':
      return {
        title: t('Abwesenheitslimit'),
        msg: t('Zu viele Kolleginnen und Kollegen sind gleichzeitig abwesend.'),
      };
    default:
      return { title: v.code, msg: v.message ?? '' };
  }
}

export const isMinorCode = (c: string) => MINOR_CODES.has(c);
export const OVERRIDABLE = new Set(['DAILY_LIMIT', 'MINOR_REST', 'REST_PERIOD']);

export { fdate };
