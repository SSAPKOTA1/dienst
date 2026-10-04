import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { download, useGet, useSend } from '../lib/api';
import { fdate } from '../lib/format';
import { Dialog, ErrorNote, Field, useToast } from '../components/ui';

const card: React.CSSProperties = {
  border: '2px solid var(--color-text)',
  margin: 'var(--space-3)',
  background: 'var(--color-bg)',
};
const head: React.CSSProperties = {
  margin: 0,
  padding: 'var(--space-2) var(--space-3)',
  fontSize: 13,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  background: 'var(--color-surface)',
  borderBottom: '2px solid var(--color-text)',
};
const line: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3)',
  borderBottom: '1px solid var(--color-divider)',
  fontSize: 14,
};
const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** Account extras of the portal: availability, qualifications, documents and the calendar subscription. */
export function PortalExtras() {
  const { t } = useTranslation();
  const toast = useToast();
  const features = useGet('/me/features');
  const on = (k: string) => features.data?.[k] !== false;
  const av = useGet(on('availability') ? '/me/availability' : null);
  const del = useSend<number>('DELETE', (id) => `/me/availability/${id}`);
  const quals = useGet('/me/qualifications');
  const docs = useGet(on('documents') ? '/me/documents' : null);
  const [dlg, setDlg] = useState(false);
  const [feed, setFeed] = useState<string | null>(null);
  const makeFeed = useSend<void, { path: string }>('POST', '/me/calendar-feed');
  const dropFeed = useSend<void>('DELETE', '/me/calendar-feed');
  return (
    <>
      {on('availability') && (
        <section style={card} aria-labelledby="av-h">
          <h2 id="av-h" style={{ ...head, display: 'flex', alignItems: 'center' }}>
            <span style={{ marginRight: 'auto' }}>{t('Verfügbarkeit')}</span>
            <button className="btn btn-secondary" onClick={() => setDlg(true)} data-testid="avail-new">
              {t('Zeit eintragen')}
            </button>
          </h2>
          {(av.data?.items ?? []).length === 0 && <div style={line}>{t('Keine Einträge.')}</div>}
          {(av.data?.items ?? []).map((a: any) => (
            <div
              key={a.id}
              style={{ ...line, display: 'flex', gap: 8, alignItems: 'baseline' }}
              data-testid="avail-row"
            >
              <b>{t(WD[a.weekday - 1]!)}</b> {a.from}–{a.to}
              <span className={`tag ${a.kind === 'unavailable' ? 'tag-neutral' : 'tag-accent'}`}>
                {a.kind === 'unavailable' ? t('nicht verfügbar') : t('bevorzugt')}
              </span>
              {a.note && <span style={{ fontSize: 12 }}>{a.note}</span>}
              <button
                className="btn btn-ghost"
                style={{ marginLeft: 'auto' }}
                onClick={() => del.mutate(a.id, { onSuccess: () => void av.refetch() })}
              >
                {t('Löschen')}
              </button>
            </div>
          ))}
        </section>
      )}
      {(quals.data?.items ?? []).length > 0 && (
        <section style={card} aria-labelledby="ql-h">
          <h2 id="ql-h" style={head}>
            {t('Qualifikationen')}
          </h2>
          {quals.data.items.map((q: any) => (
            <div key={q.qualificationId} style={line}>
              {q.name}
              {q.validUntil ? ` · ${t('gültig bis')} ${fdate(q.validUntil)}` : ''}
            </div>
          ))}
        </section>
      )}
      {on('documents') && (docs.data?.items ?? []).length > 0 && (
        <section style={card} aria-labelledby="dc-h">
          <h2 id="dc-h" style={head}>
            {t('Dokumente')}
          </h2>
          {docs.data.items.map((d: any) => (
            <div
              key={d.id}
              style={{ ...line, display: 'flex', gap: 8, alignItems: 'center' }}
              data-testid="my-doc"
            >
              <span style={{ marginRight: 'auto' }}>{d.title}</span>
              <button
                className="btn btn-secondary"
                onClick={() =>
                  void download(`/me/documents/${d.id}/download`, {}, d.fileName).catch(() =>
                    toast(t('Download fehlgeschlagen')),
                  )
                }
              >
                {t('Herunterladen')}
              </button>
            </div>
          ))}
        </section>
      )}
      {on('calendar_feed') && (
        <section style={card} aria-labelledby="cf-h">
          <h2 id="cf-h" style={head}>
            {t('Kalender-Abo')}
          </h2>
          <div style={{ ...line, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13 }}>
              {t(
                'Deinen Dienstplan im Kalender-App abonnieren (nur veröffentlichte Schichten). Der Link ist geheim; ein neuer Link macht den alten ungültig.',
              )}
            </span>
            {feed && (
              <code
                data-testid="feed-url"
                style={{
                  wordBreak: 'break-all',
                  fontSize: 12,
                  border: '1px solid var(--color-divider)',
                  padding: 6,
                }}
              >{`${window.location.origin}${feed}`}</code>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-secondary"
                data-testid="feed-create"
                onClick={() => makeFeed.mutate(undefined as any, { onSuccess: (r) => setFeed(r.path) })}
              >
                {feed ? t('Neuen Link erzeugen') : t('Link erzeugen')}
              </button>
              <button
                className="btn btn-ghost"
                onClick={() =>
                  dropFeed.mutate(undefined as any, {
                    onSuccess: () => {
                      setFeed(null);
                      toast(t('Link gelöscht'));
                    },
                  })
                }
              >
                {t('Link löschen')}
              </button>
            </div>
          </div>
        </section>
      )}
      {dlg && (
        <AvailDialog
          onClose={() => setDlg(false)}
          onDone={() => {
            setDlg(false);
            void av.refetch();
          }}
        />
      )}
    </>
  );
}

function AvailDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [weekday, setWeekday] = useState('1');
  const [from, setFrom] = useState('08:00');
  const [to, setTo] = useState('12:00');
  const [kind, setKind] = useState('unavailable');
  const [note, setNote] = useState('');
  const m = useSend<any>('POST', '/me/availability');
  return (
    <Dialog
      title={t('Verfügbarkeit eintragen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={m.isPending}
            onClick={() =>
              m.mutate(
                { weekday: Number(weekday), from, to, kind, note: note || undefined },
                { onSuccess: onDone },
              )
            }
          >
            {t('Speichern')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Wochentag')} htmlFor="av-wd">
        <select id="av-wd" className="input" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
          {WD.map((d, i) => (
            <option key={d} value={i + 1}>
              {t(d)}
            </option>
          ))}
        </select>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label={t('Von')} htmlFor="av-from">
          <input
            id="av-from"
            type="time"
            className="input"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label={t('Bis')} htmlFor="av-to">
          <input
            id="av-to"
            type="time"
            className="input"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
      </div>
      <Field label={t('Art')} htmlFor="av-kind">
        <select id="av-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="unavailable">{t('Ich kann nicht arbeiten')}</option>
          <option value="preferred">{t('Ich arbeite bevorzugt')}</option>
        </select>
      </Field>
      <Field label={t('Anmerkung (optional)')} htmlFor="av-note">
        <input
          id="av-note"
          className="input"
          maxLength={200}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}
