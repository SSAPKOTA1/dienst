import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { api, useGet } from '../lib/api';
import { fdate } from '../lib/format';
import { Dialog, ErrorNote, Field, Kicker, useToast } from '../components/ui';

const hm = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(iso))
    : '';

export function Live() {
  const { t } = useTranslation();
  const hotels = useGet('/hotels');
  const live = useGet('/live', undefined, { refetchInterval: 15_000 });
  const [close, setClose] = useState<any | null>(null);
  const g = live.data?.groups;
  const names = (hotels.data?.items ?? []).map((h: any) => h.name).join(' + ');
  const server = live.data?.serverTime;
  const cols = [
    { key: 'in', title: t('Eingestempelt'), items: g?.clockedIn ?? [], empty: t('Niemand eingestempelt.') },
    {
      key: 'exp',
      title: t('Erwartet, nicht da'),
      items: g?.expectedNotIn ?? [],
      empty: t('Alle Erwarteten sind da.'),
    },
    { key: 'rev', title: t('Prüfung nötig'), items: g?.needsReview ?? [], empty: t('Nichts zu prüfen.') },
    { key: 'no', title: t('Nicht erschienen'), items: g?.noShow ?? [], empty: t('Heute niemand.') },
  ];
  return (
    <main style={{ flex: 1 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
          padding: 'var(--space-4)',
          borderBottom: '2px solid var(--color-divider)',
        }}
      >
        <div style={{ marginRight: 'auto' }}>
          <Kicker>
            {t('Live-Übersicht')} · {names}
          </Kicker>
          <h1 style={{ margin: '2px 0 0', fontSize: 30 }}>
            {server
              ? new Intl.DateTimeFormat(i18n.language === 'en' ? 'en-GB' : 'de-DE', {
                  timeZone: 'Europe/Berlin',
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                }).format(new Date(server))
              : ''}
          </h1>
        </div>
        <div>
          <div
            style={{
              fontSize: 11,
              letterSpacing: '.08em',
              textTransform: 'uppercase',
              color: 'var(--color-neutral-700)',
            }}
          >
            {t('Serverzeit')}
          </div>
          <div
            style={{ fontSize: 36, fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}
            data-testid="server-time"
          >
            {hm(server)}
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))' }}>
        {cols.map((c) => (
          <section
            key={c.key}
            style={{
              borderRight: '2px solid var(--color-divider)',
              borderBottom: '2px solid var(--color-divider)',
              minHeight: 340,
            }}
            data-testid={`live-${c.key}`}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 'var(--space-2)',
                padding: 'var(--space-3) var(--space-4)',
                borderBottom: '2px solid var(--color-divider)',
                background: 'var(--color-surface)',
              }}
            >
              <h2
                style={{
                  margin: 0,
                  fontSize: 14,
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  marginRight: 'auto',
                }}
              >
                {c.title}
              </h2>
              <span
                style={{ fontSize: 32, lineHeight: 1, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}
              >
                {c.items.length}
              </span>
            </div>
            {c.items.map((it: any) => (
              <div
                key={`${it.punchRecordId ?? it.entryId}`}
                style={{
                  padding: 'var(--space-2) var(--space-4)',
                  borderBottom: '1px solid var(--color-divider)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 15, fontWeight: 700, marginRight: 'auto' }}>{it.displayName}</span>
                  <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                    {c.key === 'in' || c.key === 'rev'
                      ? `${t('seit')} ${hm(it.since)}`
                      : `${hm(it.plannedStart)}–${hm(it.plannedEnd)}`}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
                  {it.departmentName}
                  {c.key === 'exp' || c.key === 'no'
                    ? ` · ${it.minutesLate} ${t('Min.')} ${t('zu spät')}`
                    : ''}
                  {c.key === 'in' && it.plannedEnd ? ` · ${t('bis')} ${hm(it.plannedEnd)}` : ''}
                </div>
                {(it.flags ?? []).map((f: string) => (
                  <span
                    key={f}
                    className="tag"
                    style={{ alignSelf: 'flex-start', background: 'var(--warn-bg)', color: 'var(--warn)' }}
                  >
                    {t(f === 'unplanned' ? 'Ungeplant' : 'Abweichung')}
                  </span>
                ))}
                {c.key === 'rev' && (
                  <>
                    <span
                      className="tag"
                      style={{ alignSelf: 'flex-start', background: 'var(--warn-bg)', color: 'var(--warn)' }}
                    >
                      {it.reason === 'unplanned_long'
                        ? t('Ungeplant, seit über 10 Std. offen')
                        : t('Ausstempeln fehlt')}
                    </span>
                    <button
                      className="btn btn-secondary"
                      style={{ alignSelf: 'flex-start', marginTop: 4 }}
                      onClick={() => setClose(it)}
                      data-testid={`close-${it.punchRecordId}`}
                    >
                      {t('Per Korrektur schließen')}
                    </button>
                  </>
                )}
              </div>
            ))}
            {c.items.length === 0 && (
              <div
                style={{
                  padding: 'var(--space-3) var(--space-4)',
                  fontSize: 13,
                  color: 'var(--color-neutral-700)',
                }}
              >
                {c.empty}
              </div>
            )}
          </section>
        ))}
      </div>
      {close && (
        <CloseDialog
          item={close}
          onClose={() => setClose(null)}
          onDone={() => {
            setClose(null);
            void live.refetch();
          }}
        />
      )}
    </main>
  );
}

function CloseDialog({ item, onClose, onDone }: { item: any; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const def = item.plannedEnd ? hm(item.plannedEnd) : hm(new Date().toISOString());
  const [out, setOut] = useState(def);
  const [brk, setBrk] = useState('30');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    try {
      const day = (item.plannedEnd ?? item.since).slice(0, 10);
      const local = new Date(`${day}T${out}:00`);
      // the browser interprets the time in its own zone; the hotel zone is Europe/Berlin
      const iso = new Date(local.getTime()).toISOString();
      await api('/live/close-open', {
        body: { punchRecordId: item.punchRecordId, outAt: iso, breakMinutes: Number(brk) || 0, reason },
      });
      toast(t('Eintrag geschlossen.'));
      onDone();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Dialog
      title={`${t('Per Korrektur schließen')}: ${item.displayName}`}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={reason.trim().length < 5}
            onClick={() => void save()}
            data-testid="close-save"
          >
            {t('Speichern')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13 }}>
        {t('Eingestempelt')} {fdate(item.since, { day: '2-digit', month: '2-digit' })} {hm(item.since)}
      </div>
      <Field label={t('Ausgestempelt um (Uhrzeit)')} htmlFor="co">
        <input
          id="co"
          className="input"
          value={out}
          onChange={(e) => setOut(e.target.value)}
          placeholder="HH:mm"
        />
      </Field>
      <Field label={t('Pause (Min.)')} htmlFor="cb">
        <input id="cb" className="input" value={brk} onChange={(e) => setBrk(e.target.value)} />
      </Field>
      <Field label={t('Begründung (wird protokolliert)')} htmlFor="cr">
        <textarea id="cr" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorNote error={error} />
    </Dialog>
  );
}
