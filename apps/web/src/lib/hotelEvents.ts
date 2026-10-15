import type { HotelEventDto, HotelEventKind } from '@dienst/shared';

/** German labels of the kinds; they are passed through t() where shown. */
export const EVENT_KIND_LABEL: Record<HotelEventKind, string> = {
  messe: 'Messe',
  tagung: 'Tagung',
  gruppe: 'Gruppe',
  event: 'Event',
  other: 'Sonstiges',
};

/** Tooltip text of an entry: kind, title, dates and note. */
export const eventTitle = (e: HotelEventDto, t: (k: string) => string): string =>
  `${t(EVENT_KIND_LABEL[e.kind])}: ${e.title} (${e.startDate.split('-').reverse().join('.')}${
    e.endDate !== e.startDate ? ` – ${e.endDate.split('-').reverse().join('.')}` : ''
  })${e.note ? `\n${e.note}` : ''}`;
