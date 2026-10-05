import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { download, useGet, useSend } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fdate, fnum, fsigned, WEEKDAYS } from '../lib/format';
import { LedgerTable } from '../components/Ledger';
import { DocumentsPanel, QualificationsEditor, TerminatePanel } from './StaffMore';
import { ErrorNote, Kicker, Label, PageHead, useToast } from '../components/ui';

const EMPLOYMENT: Record<string, string> = {
  full_time: 'Vollzeit',
  part_time: 'Teilzeit',
  minijob: 'Minijob',
  werkstudent: 'Werkstudent',
  apprentice: 'Azubi',
  short_term: 'Kurzfristig',
  other: 'Sonstiges',
};
export const employmentLabel = (k: string | null) => (k ? (EMPLOYMENT[k] ?? k) : '');

export function Staff() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { id } = useParams();
  const { me } = useAuth();
  const [q, setQ] = useState('');
  const canCreate = me?.role === 'admin' || me?.role === 'superAdmin';
  const list = useGet('/employees', { q: q || undefined, pageSize: 200 });
  const items: any[] = list.data?.items ?? [];
  const selected = id ? Number(id) : null;
  const hotels = new Set(items.map((e) => e.homeHotel.id));

  return (
    <main
      style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', flex: 1 }}
      className="staff-grid"
    >
      <section style={{ minWidth: 0, borderRight: '2px solid var(--color-divider)' }}>
        <PageHead
          kicker={`${hotels.size} ${t('Hotels')} · ${list.data?.total ?? 0} ${t('zugeordnet')}`}
          title={t('Mitarbeiter')}
        >
          <input
            className="input"
            style={{ width: 220 }}
            placeholder={t('Name suchen')}
            aria-label={t('Name suchen')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {canCreate && (
            <>
              <Link className="btn btn-secondary" to="/staff/import">
                {t('Excel-Import')}
              </Link>
              <Link className="btn btn-primary" to="/staff/new">
                {t('Mitarbeiter anlegen')}
              </Link>
            </>
          )}
        </PageHead>
        <div style={{ overflowX: 'auto', borderTop: '2px solid var(--color-divider)' }}>
          <table className="table" style={{ minWidth: 640 }}>
            <thead>
              <tr>
                <th style={{ paddingLeft: 'var(--space-4)' }}>{t('Name')}</th>
                <th>{t('Nr.')}</th>
                <th>{t('Abteilung')}</th>
                <th>{t('Soll/Woche')}</th>
                <th>{t('Urlaub übrig')}</th>
                <th>{t('Zeitkonto')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => {
                const reduced = e.view === 'reduced';
                return (
                  <tr
                    key={e.employeeId}
                    onClick={() => nav(`/staff/${e.employeeId}`)}
                    style={{
                      cursor: 'pointer',
                      background: selected === e.employeeId ? 'var(--color-surface)' : undefined,
                    }}
                  >
                    <td style={{ paddingLeft: 'var(--space-4)' }}>
                      <Link
                        to={`/staff/${e.employeeId}`}
                        style={{ fontWeight: 700, color: 'inherit', textDecoration: 'none' }}
                      >
                        {e.displayName}
                      </Link>{' '}
                      {e.isMinor && (
                        <span className="tag tag-accent" style={{ padding: '0 5px', fontSize: 10 }}>
                          U18
                        </span>
                      )}{' '}
                      {e.isFloater && (
                        <span className="tag tag-outline" style={{ padding: '0 5px', fontSize: 10 }}>
                          {t('Springer')}
                        </span>
                      )}
                      {e.status === 'inactive' && (
                        <span className="tag tag-neutral" style={{ padding: '0 5px', fontSize: 10 }}>
                          {t('Inaktiv')}
                        </span>
                      )}
                      {reduced && (
                        <span className="tag tag-neutral" style={{ padding: '0 5px', fontSize: 10 }}>
                          {t('Anderes Hotel')}
                        </span>
                      )}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{e.personnelNumber}</td>
                    <td>
                      {e.department.name}
                      {reduced ? ` · ${e.homeHotel.name}` : ''}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {reduced
                        ? ''
                        : e.targetHoursPerWeek != null
                          ? `${fnum(e.targetHoursPerWeek)} ${t('Std.')}`
                          : '–'}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {reduced ? '' : fnum(e.vacationRemaining)}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {reduced ? '' : fsigned(e.timeAccount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <aside
        data-noprint
        style={{
          padding: 'var(--space-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
          minWidth: 0,
        }}
      >
        {selected ? (
          <StaffDetail id={selected} />
        ) : (
          <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', fontSize: 13 }}>
            {t('Wähle eine Person in der Liste.')}
          </div>
        )}
      </aside>
    </main>
  );
}

function BadgePanel({ id, has }: { id: number; has: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [shown, setShown] = useState<{ badge: string; qrDataUrl: string } | null>(null);
  const make = useSend<void, { badge: string; qrDataUrl: string }>('POST', `/employees/${id}/badge`);
  const drop = useSend('DELETE', `/employees/${id}/badge`);
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}
      data-testid="badge-panel"
    >
      <Label>{t('Badge (QR/NFC)')}</Label>
      <div style={{ fontSize: 13 }}>{has ? t('Badge zugewiesen.') : t('Kein Badge zugewiesen.')}</div>
      {shown && (
        <div style={{ border: '2px solid var(--color-accent)', padding: 'var(--space-3)' }} role="status">
          <img src={shown.qrDataUrl} alt={t('QR-Code des Badges')} width={160} height={160} />
          <div style={{ fontFamily: 'monospace' }} data-testid="badge-value">
            {shown.badge}
          </div>
          <div style={{ fontSize: 12 }}>
            {t('Wird nur einmal angezeigt. Ausdrucken und persönlich übergeben.')}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <button className="btn btn-secondary" onClick={() => make.mutate(undefined, { onSuccess: setShown })}>
          {has ? t('Neuen Badge erzeugen') : t('Badge erzeugen')}
        </button>
        {has && (
          <button
            className="btn btn-ghost"
            onClick={() =>
              drop.mutate(undefined, { onSuccess: () => (setShown(null), toast(t('Badge entfernt.'))) })
            }
          >
            {t('Badge entfernen')}
          </button>
        )}
      </div>
      <ErrorNote error={make.error ?? drop.error} />
    </div>
  );
}

function StaffDetail({ id }: { id: number }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { me } = useAuth();
  const q = useGet(`/employees/${id}`);
  const [pin, setPin] = useState<string | null>(null);
  const [code, setCode] = useState<{ username: string | null; code: string } | null>(null);
  const reset = useSend<void, { pin: string }>('POST', `/employees/${id}/reset-pin`);
  const unlock = useSend('POST', `/employees/${id}/unlock-pin`);
  const deact = useSend('POST', `/employees/${id}/deactivate`);
  const resend = useSend('POST', `/employees/${id}/resend-invitation`);
  const resetAct = useSend<void, { username: string; code: string }>(
    'POST',
    `/employees/${id}/reset-activation`,
  );
  const e = q.data;
  if (!e) return null;
  const admin = me?.role === 'admin' || me?.role === 'superAdmin';
  const reduced = e.view === 'reduced';
  const facts: Array<[string, string]> = [
    [t('Stammhaus'), e.homeHotel.name],
    [t('Abteilung'), e.department.name],
  ];
  if (!reduced) {
    if (e.dateOfBirth) facts.push([t('Geburtsdatum'), fdate(e.dateOfBirth)]);
    facts.push([t('Beschäftigung'), t(employmentLabel(e.employmentType))]);
    facts.push([
      t('Soll pro Woche'),
      e.targetHoursPerWeek != null ? `${fnum(e.targetHoursPerWeek)} ${t('Std.')}` : '–',
    ]);
    facts.push([`${t('Resturlaub')} ${e.vacation.year}`, `${fnum(e.vacation.remaining)} ${t('Tage')}`]);
    facts.push([t('Zeitkonto'), e.timeAccount == null ? '–' : fsigned(e.timeAccount)]);
  }
  const locked = e.pin?.lockedUntil && new Date(e.pin.lockedUntil) > new Date();
  return (
    <>
      <div>
        <Kicker>
          {t('Personalnummer')} {e.personnelNumber}
        </Kicker>
        <h2 style={{ margin: '2px 0', fontSize: 28, lineHeight: 1.1 }}>
          {e.firstName ? `${e.firstName} ${e.lastName}` : e.displayName}
        </h2>
        <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
          {t(employmentLabel(e.employmentType))} {e.isFloater ? `· ${t('Springer')}` : ''}{' '}
          {e.status === 'inactive' ? `· ${t('Inaktiv')}` : ''}
        </div>
      </div>
      {reduced && (
        <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', fontSize: 13 }}>
          {t('Reduzierte Ansicht')}: {t('Stammhaus')} {e.homeHotel.name}.{' '}
          {t('Kontaktdaten und Abwesenheitsarten sieht nur die Leitung des Stammhauses.')}
        </div>
      )}
      <hr className="hr" style={{ margin: 0 }} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3) var(--space-4)' }}>
        {facts.map(([k, v]) => (
          <div key={k}>
            <Label>{k}</Label>
            <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{v}</div>
          </div>
        ))}
      </div>
      {!reduced && (
        <>
          <hr className="hr" style={{ margin: 0 }} />
          <div>
            <div style={{ marginBottom: 6 }}>
              <Label>{t('Arbeitstage')}</Label>
            </div>
            <div style={{ display: 'flex', gap: 2 }}>
              {WEEKDAYS.map((d, i) => {
                const on = (e.workingWeekdays as number[]).includes(i + 1);
                return (
                  <span
                    key={d}
                    style={{
                      width: 32,
                      padding: '5px 0',
                      textAlign: 'center',
                      fontSize: 12,
                      fontWeight: 700,
                      background: on ? 'var(--color-text)' : 'var(--color-neutral-200)',
                      color: on ? 'var(--color-bg)' : 'var(--color-neutral-700)',
                    }}
                  >
                    {t(d)}
                  </span>
                );
              })}
            </div>
          </div>
        </>
      )}
      {!reduced && e.timeAccount != null && (
        <>
          <hr className="hr" style={{ margin: 0 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <Label>{t('Arbeitszeitkonto')}</Label>
            <LedgerTable path={`/employees/${id}/time-account/ledger`} canEdit={admin} employeeId={id} />
          </div>
        </>
      )}
      {!reduced && (
        <>
          <hr className="hr" style={{ margin: 0 }} />
          <QualificationsEditor id={id} />
        </>
      )}
      {admin && !reduced && (
        <>
          <hr className="hr" style={{ margin: 0 }} />
          <DocumentsPanel id={id} />
          <hr className="hr" style={{ margin: 0 }} />
          <TerminatePanel id={id} name={e.displayName} lastDay={e.contractEndDate ?? null} />
        </>
      )}
      {!reduced && <TimesheetDownload id={id} name={e.displayName} />}
      {admin && (
        <>
          <hr className="hr" style={{ margin: 0 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <Label>{t('Tablet-PIN')}</Label>
            {pin && (
              <div
                style={{ border: '2px solid var(--color-accent)', padding: 'var(--space-3)' }}
                role="status"
              >
                <div
                  style={{
                    fontSize: 28,
                    fontWeight: 800,
                    letterSpacing: '.2em',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {pin}
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
                  {t('Wird nur einmal angezeigt. Persönlich übergeben.')}
                </div>
              </div>
            )}
            {locked && (
              <div className="tag tag-accent" style={{ alignSelf: 'flex-start' }}>
                {t('PIN gesperrt')}
              </div>
            )}
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <button
                className="btn btn-secondary"
                onClick={() => reset.mutate(undefined, { onSuccess: (r) => setPin(r.pin) })}
              >
                {t('PIN zurücksetzen')}
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => unlock.mutate(undefined, { onSuccess: () => toast(t('Sperre aufgehoben.')) })}
              >
                {t('Sperre aufheben')}
              </button>
            </div>
            <ErrorNote error={reset.error ?? unlock.error} />
          </div>
          <hr className="hr" style={{ margin: 0 }} />
          <BadgePanel id={id} has={!!e.hasBadge} />
          <hr className="hr" style={{ margin: 0 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <Label>{t('Konto')}</Label>
            <div style={{ fontSize: 13 }}>
              {e.account.username ?? e.account.email} ·{' '}
              {t(
                e.account.status === 'active'
                  ? 'Aktiv'
                  : e.account.status === 'pending_invite'
                    ? 'Einladung offen'
                    : 'Gesperrt',
              )}
              {e.account.lastLoginAt ? ` · ${t('Letzte Anmeldung')}: ${fdate(e.account.lastLoginAt)}` : ''}
            </div>
            {code && (
              <div
                style={{ border: '2px solid var(--color-accent)', padding: 'var(--space-3)' }}
                role="status"
              >
                <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '.15em' }}>{code.code}</div>
                <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
                  {t('Benutzername')}: {code.username} ·{' '}
                  {t('Wird nur einmal angezeigt. Persönlich übergeben.')}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              {e.account.email ? (
                <button
                  className="btn btn-secondary"
                  onClick={() =>
                    resend.mutate(undefined, { onSuccess: () => toast(t('Einladung gesendet.')) })
                  }
                >
                  {t('Einladung erneut senden')}
                </button>
              ) : (
                <button
                  className="btn btn-secondary"
                  onClick={() => resetAct.mutate(undefined, { onSuccess: (r) => setCode(r) })}
                >
                  {t('Neuen Aktivierungscode')}
                </button>
              )}
              {e.status === 'active' && (
                <button
                  className="btn btn-ghost"
                  onClick={() =>
                    window.confirm(t('Mitarbeiter wirklich deaktivieren?')) &&
                    deact.mutate(undefined, { onSuccess: () => toast(t('Mitarbeiter deaktiviert.')) })
                  }
                >
                  {t('Deaktivieren')}
                </button>
              )}
            </div>
            <ErrorNote error={resend.error ?? resetAct.error ?? deact.error} />
          </div>
        </>
      )}
    </>
  );
}

function TimesheetDownload({ id, name }: { id: number; name: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  const get = (format: 'pdf' | 'xlsx') =>
    void download(
      '/timesheets',
      { employeeId: id, month, format },
      `stundenzettel_${name.replace(/[^A-Za-z0-9]+/g, '_')}_${month}.${format}`,
    ).catch(() => toast(t('Export fehlgeschlagen')));
  return (
    <>
      <hr className="hr" style={{ margin: 0 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <Label>{t('Stundenzettel')}</Label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="month"
            className="input"
            aria-label={t('Monat')}
            style={{ width: 'auto' }}
            value={month}
            onChange={(ev) => setMonth(ev.target.value)}
          />
          <button className="btn btn-secondary" data-testid="timesheet-pdf" onClick={() => get('pdf')}>
            PDF
          </button>
          <button className="btn btn-secondary" onClick={() => get('xlsx')}>
            Excel
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
          {t('Es werden nur freigegebene Zeiten ausgewiesen.')}
        </div>
      </div>
    </>
  );
}
