import type { HotelDto, HotelEventDto, HotelEventKind, Items } from '@dienst/shared';
import { HOTEL_EVENT_KINDS } from '@dienst/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../lib/api';
import { EVENT_KIND_LABEL, eventTitle } from '../lib/hotelEvents';
import { Dialog, ErrorNote, Field, PageHead, useToast } from '../components/ui';
import { DOW, addDaysIso, dayNum, mondayOfIso, todayIso } from './planning/util';

const shiftMonth = (m: string, n: number) =>
  new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 7);
const MONTHS = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];

/** Event calendar of a hotel (Messe, Tagung, Gruppe ...): planners note special days; the plan shows them. */
export function EventCalendar() {
  const { t } = useTranslation();
  const toast = useToast();
  const hotels = useGet<Items<HotelDto>>('/hotels');
  const [hotelSel, setHotelSel] = useState<number | null>(null);
  const [month, setMonth] = useState(() => todayIso().slice(0, 7));
  const [dlg, setDlg] = useState<{ event?: HotelEventDto; date?: string } | null>(null);
  const list = hotels.data?.items ?? [];
  const hotelId = hotelSel ?? list[0]?.id ?? null;

  const first = mondayOfIso(`${month}-01`);
  const lastOfMonth = addDaysIso(`${shiftMonth(month, 1)}-01`, -1);
  const weeks = Math.ceil((Date.parse(lastOfMonth) - Date.parse(first)) / 86_400_000 / 7 + 1 / 7);
  const days = Array.from({ length: weeks * 7 }, (_, i) => addDaysIso(first, i));
  const events = useGet<Items<HotelEventDto>>(
    hotelId ? '/hotel-events' : null,
    hotelId ? { hotelIds: [hotelId], from: days[0], to: days[days.length - 1] } : undefined,
  );
  const items = events.data?.items ?? [];
  const today = todayIso();

  return (
    <main style={{ flex: 1, minWidth: 0 }}>
      <PageHead kicker={t('Planung')} title={t('Ereigniskalender')}>
        {list.length > 1 && (
          <select
            className="input"
            aria-label={t('Hotel')}
            value={hotelId ?? ''}
            onChange={(e) => setHotelSel(Number(e.target.value))}
          >
            {list.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-secondary" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
          ‹ {t('Zurück')}
        </button>
        <b style={{ minWidth: 130, textAlign: 'center' }} aria-live="polite">
          {t(MONTHS[Number(month.slice(5, 7)) - 1])} {month.slice(0, 4)}
        </b>
        <button className="btn btn-secondary" onClick={() => setMonth((m) => shiftMonth(m, 1))}>
          {t('Weiter')} ›
        </button>
        <button
          className="btn btn-primary"
          disabled={!hotelId}
          data-testid="ev-new"
          onClick={() => setDlg({ date: today })}
        >
          {t('Eintrag anlegen')}
        </button>
      </PageHead>
      <div style={{ padding: '0 var(--space-4) var(--space-4)' }}>
        <div style={{ fontSize: 13, marginBottom: 8 }}>
          {t('Besondere Tage des Hotels. Sie erscheinen im Dienstplan über dem Tag.')}
        </div>
        <div
          role="grid"
          aria-label={t('Ereigniskalender')}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
            border: '2px solid var(--color-text)',
          }}
        >
          {DOW.map((d) => (
            <div
              key={d}
              role="columnheader"
              style={{ padding: '4px 6px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.08em' }}
            >
              {t(d)}
            </div>
          ))}
          {days.map((date) => {
            const dayEvents = items.filter((e) => e.startDate <= date && e.endDate >= date);
            const inMonth = date.startsWith(month);
            return (
              <div
                key={date}
                role="gridcell"
                data-testid="ev-day"
                style={{
                  minHeight: 92,
                  padding: 4,
                  borderTop: '1px solid var(--color-divider)',
                  borderLeft: '1px solid var(--color-divider)',
                  background:
                    date === today
                      ? 'var(--color-accent-100)'
                      : inMonth
                        ? undefined
                        : 'var(--color-neutral-200)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <button
                  className="btn btn-ghost"
                  style={{ alignSelf: 'flex-start', padding: '0 4px', fontWeight: 800 }}
                  aria-label={`${t('Eintrag anlegen')} ${dayNum(date)}.`}
                  onClick={() => setDlg({ date })}
                >
                  {dayNum(date)}.
                </button>
                {dayEvents.map((e) => (
                  <button
                    key={e.id}
                    className="btn btn-secondary"
                    data-testid="ev-chip"
                    title={eventTitle(e, t)}
                    style={{
                      padding: '1px 4px',
                      fontSize: 12,
                      textAlign: 'left',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    onClick={() => setDlg({ event: e })}
                  >
                    {t(EVENT_KIND_LABEL[e.kind])}: {e.title}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {dlg && hotelId && (
        <EventDialog
          hotelId={hotelId}
          event={dlg.event}
          date={dlg.date ?? today}
          onClose={() => setDlg(null)}
          onDone={(msg) => {
            setDlg(null);
            toast(t(msg));
            void events.refetch();
          }}
        />
      )}
    </main>
  );
}

function EventDialog({
  hotelId,
  event,
  date,
  onClose,
  onDone,
}: {
  hotelId: number;
  event?: HotelEventDto;
  date: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(event?.title ?? '');
  const [kind, setKind] = useState<HotelEventKind>(event?.kind ?? 'event');
  const [start, setStart] = useState(event?.startDate ?? date);
  const [end, setEnd] = useState(event?.endDate ?? date);
  const [note, setNote] = useState(event?.note ?? '');
  const save = useSend<Record<string, unknown>>(
    event ? 'PUT' : 'POST',
    event ? `/hotel-events/${event.id}` : '/hotel-events',
  );
  const del = useSend<number>('DELETE', (id) => `/hotel-events/${id}`);
  return (
    <Dialog
      title={event ? t('Eintrag bearbeiten') : t('Eintrag anlegen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            data-testid="ev-save"
            disabled={!title.trim() || !start || !end || end < start || save.isPending}
            onClick={() =>
              save.mutate(
                {
                  ...(event ? {} : { hotelId }),
                  title: title.trim(),
                  kind,
                  startDate: start,
                  endDate: end,
                  note: note.trim() || null,
                },
                { onSuccess: () => onDone('Gespeichert') },
              )
            }
          >
            {t('Speichern')}
          </button>
          {event && (
            <button
              className="btn btn-secondary"
              data-testid="ev-delete"
              onClick={() => del.mutate(event.id, { onSuccess: () => onDone('Gelöscht') })}
            >
              {t('Löschen')}
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Titel')} htmlFor="ev-t">
        <input
          id="ev-t"
          className="input"
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field label={t('Art')} htmlFor="ev-k">
        <select
          id="ev-k"
          className="input"
          value={kind}
          onChange={(e) => setKind(e.target.value as HotelEventKind)}
        >
          {HOTEL_EVENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(EVENT_KIND_LABEL[k])}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('Von')} htmlFor="ev-s">
        <input
          id="ev-s"
          type="date"
          className="input"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
      </Field>
      <Field label={t('Bis')} htmlFor="ev-e">
        <input
          id="ev-e"
          type="date"
          className="input"
          value={end}
          min={start}
          onChange={(e) => setEnd(e.target.value)}
        />
      </Field>
      <Field label={t('Notiz')} htmlFor="ev-n">
        <textarea
          id="ev-n"
          className="input"
          rows={3}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <ErrorNote error={save.error ?? del.error} />
    </Dialog>
  );
}
