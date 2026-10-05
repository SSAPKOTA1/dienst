import type {
  AuditLogPage,
  AuditVerifyDto,
  CompanyDto,
  HotelDto,
  Items,
  KioskDeviceDto,
  PayrollPeriodDto,
} from '@dienst/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, download, useGet, useSend, type ApiError } from '../lib/api';
import { fdate, fdatetime } from '../lib/format';
import { Dialog, ErrorNote, Field, useToast } from '../components/ui';
import {
  FeatureToggles,
  HourCategories,
  PayrollExport,
  QualificationManager,
  RuleLimitsEditor,
  SeverityEditor,
  TeamVisibility,
} from './AdminRulesEditor';

const wrap: React.CSSProperties = {
  padding: 'var(--space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
};

// ---------------------------------------------------------------- tablets
export function AdminTablets() {
  const { t } = useTranslation();
  const toast = useToast();
  const hotels = useGet<Items<HotelDto>>('/hotels');
  const devices = useGet<Items<KioskDeviceDto>>('/kiosk-devices', undefined, { refetchInterval: 30_000 });
  const [pair, setPair] = useState(false);
  const [shown, setShown] = useState<{ name: string; token: string } | null>(null);
  const update = useSend<{ id: number; status: string }>('PUT', (b) => `/kiosk-devices/${b.id}`, [
    ['api', '/kiosk-devices'],
  ]);
  const hotelName = (id: number) => (hotels.data?.items ?? []).find((h) => h.id === id)?.name ?? id;
  return (
    <div style={wrap}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 20, marginRight: 'auto' }}>{t('Tablets')}</h2>
        <button className="btn btn-primary" onClick={() => setPair(true)}>
          {t('Tablet koppeln')}
        </button>
      </div>
      <div style={{ overflowX: 'auto', border: '2px solid var(--color-text)' }}>
        <table className="table" style={{ minWidth: 640 }}>
          <thead>
            <tr>
              <th style={{ paddingLeft: 'var(--space-4)' }}>{t('Name')}</th>
              <th>{t('Hotel')}</th>
              <th>{t('Status')}</th>
              <th>{t('Zuletzt gesehen')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(devices.data?.items ?? []).map((d) => (
              <tr key={d.id} data-testid="device-row">
                <td style={{ paddingLeft: 'var(--space-4)', fontWeight: 700 }}>{d.name}</td>
                <td>{hotelName(d.hotelId)}</td>
                <td>
                  <span className={`tag ${d.online ? 'tag-accent' : 'tag-neutral'}`}>
                    {d.status === 'revoked' ? t('Gesperrt') : d.online ? t('Online') : t('Offline')}
                  </span>
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {d.lastSeenAt ? fdatetime(d.lastSeenAt) : t('nie')}
                </td>
                <td style={{ textAlign: 'right', paddingRight: 'var(--space-4)' }}>
                  <button
                    className="btn btn-secondary"
                    onClick={() =>
                      update.mutate(
                        { id: d.id, status: d.status === 'active' ? 'revoked' : 'active' },
                        { onSuccess: () => toast(t('Gespeichert.')) },
                      )
                    }
                  >
                    {d.status === 'active' ? t('Sperren') : t('Entsperren')}
                  </button>
                </td>
              </tr>
            ))}
            {(devices.data?.items ?? []).length === 0 && (
              <tr>
                <td colSpan={5} style={{ paddingLeft: 'var(--space-4)' }}>
                  {t('Noch kein Tablet gekoppelt.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
        {t('Ein Tablet gilt als online, wenn es in den letzten 3 Minuten ein Lebenszeichen gesendet hat.')}
      </div>
      {pair && (
        <PairDialog
          hotels={hotels.data?.items ?? []}
          onClose={() => setPair(false)}
          onDone={(d) => {
            setPair(false);
            setShown(d);
            void devices.refetch();
          }}
        />
      )}
      {shown && (
        <Dialog
          title={t('Tablet gekoppelt')}
          onClose={() => setShown(null)}
          actions={
            <button className="btn btn-primary" onClick={() => setShown(null)}>
              {t('Fertig')}
            </button>
          }
        >
          <p style={{ margin: 0, fontSize: 13 }}>
            {t('Dieser Gerätecode wird nur jetzt angezeigt. Geben Sie ihn am Tablet unter /kiosk ein.')}
          </p>
          <code
            data-testid="device-token"
            style={{
              display: 'block',
              padding: 'var(--space-2)',
              border: '2px solid var(--color-text)',
              wordBreak: 'break-all',
              fontSize: 14,
            }}
          >
            {shown.token}
          </code>
        </Dialog>
      )}
    </div>
  );
}

function PairDialog({
  hotels,
  onClose,
  onDone,
}: {
  hotels: HotelDto[];
  onClose: () => void;
  onDone: (d: { name: string; token: string }) => void;
}) {
  const { t } = useTranslation();
  const [hotelId, setHotelId] = useState(String(hotels[0]?.id ?? ''));
  const [name, setName] = useState('');
  const m = useSend<Record<string, unknown>, { name: string; token: string }>('POST', '/kiosk-devices');
  return (
    <Dialog
      title={t('Tablet koppeln')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!name || !hotelId || m.isPending}
            onClick={() =>
              m.mutate(
                { hotelId: Number(hotelId), name },
                { onSuccess: (r) => onDone({ name: r.name, token: r.token }) },
              )
            }
          >
            {t('Koppeln')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Hotel')} htmlFor="pd-hotel">
        <select id="pd-hotel" className="input" value={hotelId} onChange={(e) => setHotelId(e.target.value)}>
          {hotels.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('Name des Tablets')} htmlFor="pd-name">
        <input
          id="pd-name"
          className="input"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- rules (read-only)
const RULES: Array<[string, string, string]> = [
  ['REST_PERIOD', 'Ruhezeit zwischen Schichten', 'unter 11 h: Begründung nötig (ab 10 h), darunter gesperrt'],
  [
    'DAILY_LIMIT',
    'Höchstarbeitszeit pro Tag',
    'über 10 h gesperrt, Notfall-Ausnahme nur Administration mit Begründung',
  ],
  ['DAILY_OVER_8H', 'Mehr als 8 h pro Tag', 'Warnung, einstellbar (weich oder hart)'],
  ['MINOR_NIGHT', 'Jugendliche: Nachtruhe', 'keine Schicht zwischen 20:00 und 06:00 Uhr'],
  ['MINOR_DAILY', 'Jugendliche: Tagesarbeitszeit', 'über 8 h gesperrt'],
  ['MINOR_REST', 'Jugendliche: Ruhezeit', 'unter 12 h gesperrt, Notfall-Ausnahme mit Begründung'],
  ['OVERLAP', 'Überschneidung', 'gesperrt, auch über mehrere Hotels'],
  ['PAST_DAY', 'Vergangene Tage', 'Arbeitsschichten gesperrt'],
  ['PERIOD_CLOSED', 'Abgeschlossener Monat', 'gesperrt bis zur Wiedereröffnung'],
  ['MONTHLY_CAP', 'Monatliche Stundengrenze', 'Warnung, einstellbar (weich oder hart)'],
];
const KIOSK_RULES: Array<[string, string]> = [
  ['Toleranz beim Einstempeln', '±7 Minuten, innerhalb wird die geplante Zeit bezahlt'],
  ['Pausen', '30 Min. ab 6 h, 45 Min. ab 9 h; Pause kürzer als erforderlich braucht eine Begründung'],
  ['Automatisches Ausstempeln', '60 Minuten nach Schichtende; ungeplant nach 12 h'],
  ['PIN-Sperre', 'nach 5 Fehlversuchen für 15 Minuten'],
  ['Freigabe', 'Unauffällige Stempelungen werden automatisch freigegeben'],
];

export function AdminRules() {
  const { t } = useTranslation();
  const seen = useSend('POST', '/setup/rules-viewed');
  useEffect(() => {
    seen.mutate({});
    // report once on view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div style={wrap}>
      <h2 style={{ margin: 0, fontSize: 20 }}>{t('Regeln')}</h2>
      <div style={{ fontSize: 13 }}>
        {t('Die eingebauten Regeln gelten für alle Hotels. Die Grenzen unten dürfen nur verschärft werden.')}
      </div>
      <RuleLimitsEditor />
      <SeverityEditor />
      <HourCategories />
      <FeatureToggles />
      <TeamVisibility />
      <QualificationManager />
      <section aria-label={t('Planungsregeln')} style={{ border: '2px solid var(--color-text)' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ paddingLeft: 'var(--space-4)' }}>{t('Regel')}</th>
              <th>{t('Wirkung')}</th>
              <th>{t('Code')}</th>
            </tr>
          </thead>
          <tbody>
            {RULES.map(([code, name, effect]) => (
              <tr key={code}>
                <td style={{ paddingLeft: 'var(--space-4)', fontWeight: 700 }}>{t(name)}</td>
                <td>{t(effect)}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{code}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section aria-label={t('Tablet-Stempeln')} style={{ border: '2px solid var(--color-text)' }}>
        <table className="table">
          <tbody>
            {KIOSK_RULES.map(([name, effect]) => (
              <tr key={name}>
                <td style={{ paddingLeft: 'var(--space-4)', fontWeight: 700, width: '34%' }}>{t(name)}</td>
                <td>{t(effect)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- audit log
export function AdminAudit() {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({ action: '', entity: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const q = {
    action: f.action || undefined,
    entity: f.entity || undefined,
    from: f.from || undefined,
    to: f.to || undefined,
  };
  const log = useGet<AuditLogPage>('/audit-log', { ...q, page, pageSize: 25 });
  const verify = useGet<AuditVerifyDto>('/audit-log/verify', undefined, { enabled: false });
  const set = (k: keyof typeof f, v: string) => {
    setF({ ...f, [k]: v });
    setPage(1);
  };
  const pages = Math.max(1, Math.ceil((log.data?.total ?? 0) / 25));
  return (
    <div style={wrap}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 20, marginRight: 'auto' }}>{t('Protokoll')}</h2>
        <button
          className="btn btn-secondary"
          data-testid="audit-verify"
          disabled={verify.isFetching}
          onClick={() => void verify.refetch()}
        >
          {t('Integrität prüfen')}
        </button>
        <Field label={t('Aktion')} htmlFor="al-action">
          <input
            id="al-action"
            className="input"
            style={{ width: 170 }}
            value={f.action}
            onChange={(e) => set('action', e.target.value)}
          />
        </Field>
        <Field label={t('Objekt')} htmlFor="al-entity">
          <input
            id="al-entity"
            className="input"
            style={{ width: 150 }}
            value={f.entity}
            onChange={(e) => set('entity', e.target.value)}
          />
        </Field>
        <Field label={t('Von')} htmlFor="al-from">
          <input
            id="al-from"
            type="date"
            className="input"
            value={f.from}
            onChange={(e) => set('from', e.target.value)}
          />
        </Field>
        <Field label={t('Bis')} htmlFor="al-to">
          <input
            id="al-to"
            type="date"
            className="input"
            value={f.to}
            onChange={(e) => set('to', e.target.value)}
          />
        </Field>
        <button
          className="btn btn-secondary"
          onClick={() =>
            download('/audit-log', { ...q, format: 'csv' }, 'protokoll.csv').catch(() =>
              toast(t('Export fehlgeschlagen')),
            )
          }
        >
          {t('Als CSV exportieren')}
        </button>
      </div>
      {verify.data && (
        <div
          role="status"
          data-testid="audit-verify-result"
          style={{
            border: '2px solid var(--color-text)',
            padding: 'var(--space-2) var(--space-3)',
            fontSize: 14,
          }}
        >
          <b>{verify.data.ok ? t('Protokoll unverändert.') : t('Protokoll weicht ab!')}</b>{' '}
          {t('{{n}} Einträge in {{c}} Ketten geprüft.', {
            n: verify.data.chains.reduce((a: number, c) => a + c.rows, 0),
            c: verify.data.chains.length,
          })}
          {verify.data.chains
            .filter((c) => !c.ok)
            .map((c) => (
              <div key={c.chainKey} style={{ color: 'var(--warn)', fontWeight: 700 }}>
                {t('Kette {{k}}: erste Abweichung bei Eintrag {{id}}', { k: c.chainKey, id: c.brokenAt })}
              </div>
            ))}
          {verify.data.unverifiableLegacyRows ? (
            <div style={{ fontSize: 12 }}>
              {t('{{n}} ältere Einträge sind nicht prüfbar.', { n: verify.data.unverifiableLegacyRows })}
            </div>
          ) : null}
        </div>
      )}
      <div style={{ overflowX: 'auto', border: '2px solid var(--color-text)' }}>
        <table className="table" style={{ minWidth: 760 }}>
          <thead>
            <tr>
              <th style={{ paddingLeft: 'var(--space-4)' }}>{t('Zeit')}</th>
              <th>{t('Wer')}</th>
              <th>{t('Aktion')}</th>
              <th>{t('Objekt')}</th>
              <th>{t('Begründung')}</th>
            </tr>
          </thead>
          <tbody>
            {(log.data?.items ?? []).map((a) => (
              <tr key={a.id} data-testid="audit-row">
                <td
                  style={{
                    paddingLeft: 'var(--space-4)',
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {fdatetime(a.at)}
                </td>
                <td>{a.actor ?? t('System')}</td>
                <td style={{ fontWeight: 700 }}>{a.action}</td>
                <td>{a.entity ? `${a.entity}${a.entityId ? ` #${a.entityId}` : ''}` : '–'}</td>
                <td>{a.reason ?? ''}</td>
              </tr>
            ))}
            {(log.data?.items ?? []).length === 0 && (
              <tr>
                <td colSpan={5} style={{ paddingLeft: 'var(--space-4)' }}>
                  {t('Keine Einträge.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          ←
        </button>
        <span>
          {t('Seite')} {page} / {pages} · {log.data?.total ?? 0} {t('Einträge')}
        </span>
        <button className="btn btn-secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
          →
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- month close
export function ClosePeriods() {
  const { t } = useTranslation();
  const toast = useToast();
  const periods = useGet<Items<PayrollPeriodDto>>('/periods');
  const companies = useGet<Items<CompanyDto>>('/companies');
  const [dlg, setDlg] = useState(false);
  const [reopen, setReopen] = useState<PayrollPeriodDto | null>(null);
  return (
    <section
      style={{ padding: 'var(--space-4)', borderTop: '2px solid var(--color-divider)' }}
      data-testid="periods"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 'var(--space-2)' }}>
        <h2 style={{ margin: 0, fontSize: 20, marginRight: 'auto' }}>{t('Monatsabschluss')}</h2>
        <button className="btn btn-primary" onClick={() => setDlg(true)}>
          {t('Monat abschließen')}
        </button>
      </div>
      {(periods.data?.items ?? []).slice(0, 6).map((p) => (
        <div
          key={p.id}
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            alignItems: 'center',
            padding: '6px 0',
            borderBottom: '1px solid var(--color-divider)',
            fontSize: 13,
          }}
        >
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {fdate(p.from)} – {fdate(p.to)}
          </span>
          <span className={`tag ${p.status === 'closed' ? 'tag-accent' : 'tag-neutral'}`}>
            {p.status === 'closed' ? t('Abgeschlossen') : t('Wieder geöffnet')}
          </span>
          {p.reopenReason && <span style={{ color: 'var(--color-neutral-700)' }}>„{p.reopenReason}“</span>}
          {p.status === 'closed' && (
            <button className="btn btn-secondary" style={{ marginLeft: 'auto' }} onClick={() => setReopen(p)}>
              {t('Wieder öffnen')}
            </button>
          )}
        </div>
      ))}
      <PayrollExport />
      {dlg && (
        <CloseDialog
          companies={companies.data?.items ?? []}
          onClose={() => setDlg(false)}
          onDone={() => {
            setDlg(false);
            toast(t('Monat abgeschlossen.'));
            void periods.refetch();
          }}
        />
      )}
      {reopen && (
        <ReopenDialog
          period={reopen}
          onClose={() => setReopen(null)}
          onDone={() => {
            setReopen(null);
            void periods.refetch();
          }}
        />
      )}
    </section>
  );
}

const monthRange = (offset: number) => {
  const d = new Date();
  const first = new Date(Date.UTC(d.getFullYear(), d.getMonth() + offset, 1));
  const last = new Date(Date.UTC(d.getFullYear(), d.getMonth() + offset + 1, 0));
  return [first.toISOString().slice(0, 10), last.toISOString().slice(0, 10)] as const;
};

function CloseDialog({
  companies,
  onClose,
  onDone,
}: {
  companies: CompanyDto[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [def] = useState(() => monthRange(-1));
  const [companyId, setCompanyId] = useState(String(companies[0]?.id ?? ''));
  const [from, setFrom] = useState(def[0]);
  const [to, setTo] = useState(def[1]);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api('/periods/close', { method: 'POST', body: { companyId: Number(companyId), from, to } });
      onDone();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const pend =
    err?.code === 'PENDING_APPROVALS'
      ? (err.details as { workedTime?: PendingItem[]; corrections?: PendingItem[] })
      : null;
  return (
    <Dialog
      title={t('Monat abschließen')}
      onClose={onClose}
      width={520}
      actions={
        <>
          <button className="btn btn-primary" disabled={busy || !companyId} onClick={() => void submit()}>
            {t('Abschließen')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Unternehmen')} htmlFor="cl-co">
        <select id="cl-co" className="input" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)' }}>
        <Field label={t('Von')} htmlFor="cl-from">
          <input
            id="cl-from"
            type="date"
            className="input"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label={t('Bis')} htmlFor="cl-to">
          <input
            id="cl-to"
            type="date"
            className="input"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
      </div>
      <div style={{ fontSize: 12 }}>
        {t(
          'Nach dem Abschluss sind Planung, Stempelungen, Freigaben und Abwesenheiten in diesem Zeitraum gesperrt.',
        )}
      </div>
      {pend ? (
        <div
          role="alert"
          style={{ border: '2px solid var(--color-text)', padding: 'var(--space-2)', fontSize: 13 }}
        >
          <b>{t('Es gibt noch offene Freigaben:')}</b>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {(pend.workedTime ?? []).map((x) => (
              <li key={`w${x.id}`}>
                {x.employee} · {fdate(x.date)} {x.open ? `· ${t('noch eingestempelt')}` : ''}
              </li>
            ))}
            {(pend.corrections ?? []).map((x) => (
              <li key={`c${x.id}`}>
                {x.employee} · {t('Stempelkorrektur')}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ErrorNote error={err} />
      )}
    </Dialog>
  );
}

function ReopenDialog({
  period,
  onClose,
  onDone,
}: {
  period: PayrollPeriodDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const m = useSend('POST', `/periods/${period.id}/reopen`);
  return (
    <Dialog
      title={t('Monat wieder öffnen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={reason.trim().length < 5 || m.isPending}
            onClick={() => m.mutate({ reason }, { onSuccess: onDone })}
          >
            {t('Wieder öffnen')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Begründung (wird protokolliert)')} htmlFor="ro-reason">
        <input
          id="ro-reason"
          className="input"
          value={reason}
          maxLength={300}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}

/** Open approvals reported with the PENDING_APPROVALS error. */
interface PendingItem {
  id: number;
  employee: string;
  date?: string;
  open?: boolean;
}
