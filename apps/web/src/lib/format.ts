import i18n from '../i18n';

const loc = () => (i18n.language === 'en' ? 'en-GB' : 'de-DE');

export const fnum = (n: number | null | undefined, digits = 1): string =>
  n == null
    ? '–'
    : new Intl.NumberFormat(loc(), { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(n);

/** Signed hours with one decimal, e.g. "+12,5 h" / "−3,0 h" (as in the prototype's time account). */
export const fsigned = (n: number | null | undefined): string => {
  if (n == null) return '–';
  const s = new Intl.NumberFormat(loc(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
    Math.abs(n),
  );
  return `${n < 0 ? '−' : '+'}${s} h`;
};

export const fdate = (
  iso: string | null | undefined,
  opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' },
): string =>
  iso
    ? new Intl.DateTimeFormat(loc(), { timeZone: 'UTC', ...opts }).format(
        new Date(iso.slice(0, 10) + 'T00:00:00Z'),
      )
    : '–';

export const fdatetime = (iso: string | null | undefined, tz = 'Europe/Berlin'): string =>
  iso
    ? new Intl.DateTimeFormat(loc(), {
        timeZone: tz,
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(iso))
    : '–';

export const ftime = (iso: string | null | undefined, tz = 'Europe/Berlin'): string =>
  iso
    ? new Intl.DateTimeFormat(loc(), {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(iso))
    : '–';

export const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const;
