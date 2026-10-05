import { useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, useGet, useSend } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fdate, fdatetime } from '../lib/format';
import {
  Dialog,
  ErrorNote,
  Field,
  Kicker,
  PageHead,
  SectionTitle,
  Segmented,
  useToast,
} from '../components/ui';
import { ClosePeriods } from './AdminMore';
import { HotelPlatformSettings } from './AdminPlatform';

const TABS = [
  ['overview', 'Übersicht'],
  ['hotels', 'Hotels'],
  ['users', 'Benutzer & Rollen'],
  ['tablets', 'Tablets'],
  ['integrations', 'Schnittstellen'],
  ['rules', 'Regeln'],
  ['audit', 'Protokoll'],
] as const;

export function AdminLayout() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const company = useGet('/companies');
  const name = (company.data?.items ?? []).map((c: any) => c.name).join(', ') || 'Trip Inn Hotels';
  const base = TABS.filter(([k]) => k !== 'integrations' || me?.role !== 'manager');
  const tabs: Array<readonly [string, string]> =
    me?.role === 'superAdmin' ? [...base, ['companies', 'Unternehmen']] : [...base];
  return (
    <main style={{ flex: 1, minWidth: 0 }}>
      <PageHead kicker={`${t('Administration')} · ${name}`} title="Admin" />
      <nav
        aria-label={t('Einrichtung')}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          borderTop: '2px solid var(--color-divider)',
          borderBottom: '2px solid var(--color-divider)',
        }}
      >
        {tabs.map(([k, l]) => (
          <NavLink
            key={k}
            to={`/admin/${k}`}
            style={({ isActive }) => ({
              fontSize: 14,
              fontWeight: 700,
              padding: '11px 18px',
              borderRight: '1px solid var(--color-divider)',
              textDecoration: 'none',
              background: isActive ? 'var(--color-text)' : 'transparent',
              color: isActive ? 'var(--color-bg)' : 'var(--color-text)',
            })}
          >
            {t(l)}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </main>
  );
}

export const AdminIndex = () => <Navigate to="/admin/overview" replace />;

// ---------------------------------------------------------------- overview
export function AdminOverview() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { me } = useAuth();
  const status = useGet('/setup/status');
  const ov = useGet('/setup/overview');
  const [hidden, setHidden] = useState(false);
  const s = status.data;
  const steps = s
    ? [
        {
          t: 'Hotel und Abteilungen anlegen',
          sub: 'Name, Zeitzone, Mindestbesetzung',
          a: 'Hotels',
          done: s.hotelsDepartments.done,
          go: () => nav('/admin/hotels'),
        },
        {
          t: 'Mitarbeitende anlegen',
          sub: `${s.employees.count} ${t('angelegt')}`,
          a: 'Mitarbeiter',
          done: s.employees.done,
          go: () => nav('/staff'),
        },
        {
          t: 'Mitarbeitende einladen',
          sub: s.invitations.count
            ? `${s.invitations.count} ${t('haben sich noch nie angemeldet')}`
            : 'Alle haben sich angemeldet',
          a: 'Benutzer',
          done: s.invitations.done,
          go: () => nav('/admin/users'),
        },
        {
          t: 'Tablet koppeln',
          sub: 'Für das Stempeln mit PIN an der Rezeption',
          a: 'Tablets',
          done: s.tablet.done,
          go: () => nav('/admin/tablets'),
        },
        {
          t: 'Regeln prüfen',
          sub: 'Ruhezeiten, Pausen, Sperrzeiten',
          a: 'Regeln',
          done: s.rules.done,
          go: () => nav('/admin/rules'),
        },
        {
          t: 'Ersten Dienstplan veröffentlichen',
          sub: 'Danach sehen Mitarbeitende ihre Schichten',
          a: 'Zum Dienstplan',
          done: s.firstPublish.done,
          go: () => nav('/planning'),
        },
      ]
    : [];
  const doneN = steps.filter((x) => x.done).length;
  const k = ov.data?.kpis;
  const todoText = (a: { kind: string; count: number }) =>
    a.kind === 'open_requests'
      ? [`${a.count} ${t('Offene Anträge')}`, 'Zu Anträgen', '/requests']
      : a.kind === 'never_signed_in'
        ? [`${a.count} ${t('haben sich noch nie angemeldet')}`, 'Benutzer', '/admin/users']
        : [`${a.count} ${t('Tablets offline')}`, 'Ansehen', '/admin/tablets'];
  return (
    <div>
      {s && !hidden && doneN < steps.length && (
        <section
          style={{
            padding: 'var(--space-4)',
            borderBottom: '2px solid var(--color-divider)',
            background: 'var(--color-surface)',
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-3)',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              marginBottom: 'var(--space-3)',
            }}
          >
            <h2 style={{ margin: 0, fontSize: 20 }}>{t('Erste Schritte')}</h2>
            <span style={{ fontSize: 13, color: 'var(--color-neutral-800)' }}>
              {doneN} {t('von')} {steps.length} {t('erledigt')}
            </span>
            <div
              style={{
                flex: 1,
                minWidth: 120,
                maxWidth: 260,
                height: 8,
                background: 'var(--color-neutral-300)',
              }}
              role="progressbar"
              aria-valuenow={doneN}
              aria-valuemax={steps.length}
            >
              <div
                style={{
                  width: `${(doneN / steps.length) * 100}%`,
                  height: '100%',
                  background: 'var(--color-text)',
                }}
              />
            </div>
            <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => setHidden(true)}>
              {t('Ausblenden')}
            </button>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))',
              gap: 2,
              background: 'var(--color-divider)',
              border: '2px solid var(--color-divider)',
            }}
          >
            {steps.map((st, i) => (
              <div
                key={st.t}
                style={{
                  background: 'var(--color-bg)',
                  padding: 'var(--space-3)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  minHeight: 118,
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span
                    aria-hidden
                    style={{
                      width: 22,
                      height: 22,
                      border: '2px solid var(--color-text)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: st.done ? 'var(--color-text)' : 'transparent',
                      color: 'var(--color-bg)',
                      fontSize: 13,
                    }}
                  >
                    {st.done ? '✓' : ''}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      letterSpacing: '.08em',
                      textTransform: 'uppercase',
                      color: 'var(--color-neutral-700)',
                    }}
                  >
                    {t('Schritt')} {i + 1}
                    {st.done ? ` · ${t('erledigt')}` : ''}
                  </span>
                </div>
                <b style={{ fontSize: 15 }}>{t(st.t)}</b>
                <span style={{ fontSize: 12, color: 'var(--color-neutral-800)' }}>{t(st.sub)}</span>
                <button
                  className="btn btn-secondary"
                  style={{ marginTop: 'auto', alignSelf: 'flex-start' }}
                  onClick={st.go}
                >
                  {t(st.a)}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))',
          borderBottom: '2px solid var(--color-divider)',
        }}
      >
        {[
          ['Mitarbeitende', k?.employees],
          ['Aktive Benutzer', k?.activeUsers],
          ['Tablets online', k ? `${k.tabletsOnline}/${k.tabletsTotal}` : undefined],
          ['Offene Anträge', k?.openRequests],
        ].map(([l, v]) => (
          <div
            key={l as string}
            style={{
              padding: 'var(--space-4)',
              borderRight: '1px solid var(--color-divider)',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <div
              style={{
                fontSize: 11,
                letterSpacing: '.08em',
                textTransform: 'uppercase',
                color: 'var(--color-neutral-700)',
              }}
            >
              {t(l as string)}
            </div>
            <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
              {v ?? '–'}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))' }}>
        <section style={{ padding: 'var(--space-4)', borderRight: '2px solid var(--color-divider)' }}>
          <SectionTitle>{t('Handlungsbedarf')}</SectionTitle>
          {(ov.data?.actionNeeded ?? []).length === 0 && (
            <div style={{ fontSize: 13, padding: '8px 0' }}>{t('Nichts zu tun.')}</div>
          )}
          {(ov.data?.actionNeeded ?? []).map((a: any) => {
            const [title, action, to] = todoText(a);
            return (
              <div
                key={a.kind}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0,1fr) auto',
                  gap: 8,
                  padding: '8px 0',
                  borderBottom: '1px solid var(--color-divider)',
                  alignItems: 'center',
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div>
                <button className="btn btn-secondary" onClick={() => nav(to)}>
                  {t(action)}
                </button>
              </div>
            );
          })}
        </section>
        <section style={{ padding: 'var(--space-4)' }}>
          <SectionTitle>{t('Letzte Änderungen')}</SectionTitle>
          {(ov.data?.recentChanges ?? []).map((a: any) => (
            <div
              key={a.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '96px minmax(0,1fr)',
                gap: 8,
                padding: '8px 0',
                borderBottom: '1px solid var(--color-divider)',
                fontSize: 13,
              }}
            >
              <span style={{ color: 'var(--color-neutral-700)', fontVariantNumeric: 'tabular-nums' }}>
                {fdatetime(a.at)}
              </span>
              <span>
                <b>{a.actor ?? t('System')}</b> · {a.action}
              </span>
            </div>
          ))}
        </section>
      </div>
      {me?.role !== 'manager' && <ClosePeriods />}
    </div>
  );
}

// ---------------------------------------------------------------- hotels and departments
export function AdminHotels() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const toast = useToast();
  const hotels = useGet('/hotels');
  const depts = useGet('/departments');
  const shifts = useGet('/shifts');
  const companies = useGet('/companies');
  type Dlg =
    | { kind: 'hotel' }
    | { kind: 'dept'; hotelId: number; dept?: any }
    | { kind: 'shifts'; hotelId: number; dept: any };
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const setVis = useSend<{ id: number; employeeHoursVisibility: string }>(
    'PUT',
    (b) => `/hotels/${b.id}/settings`,
  );
  const delDept = useSend<number>('DELETE', (id) => `/departments/${id}`);
  const sa = me?.role === 'superAdmin';
  return (
    <div
      style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 20, marginRight: 'auto' }}>{t('Hotels und Mindestbesetzung')}</h2>
        {sa && (
          <button className="btn btn-primary" onClick={() => setDlg({ kind: 'hotel' })}>
            {t('Hotel anlegen')}
          </button>
        )}
      </div>
      {(hotels.data?.items ?? []).map((h: any) => (
        <section key={h.id} style={{ border: '2px solid var(--color-text)' }}>
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-3)',
              alignItems: 'center',
              flexWrap: 'wrap',
              padding: 'var(--space-3) var(--space-4)',
              background: 'var(--color-surface)',
              borderBottom: '2px solid var(--color-text)',
            }}
          >
            <h3 style={{ margin: 0, fontSize: 18, marginRight: 'auto' }}>{h.name}</h3>
            <span style={{ fontSize: 13 }}>
              {h.city} · {h.federalState} · {h.timezone}
            </span>
            {me?.role !== 'manager' && (
              <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
                {t('Stunden für Mitarbeitende sichtbar')}
                <select
                  className="input"
                  style={{ width: 'auto', minHeight: 30, padding: '2px 6px' }}
                  value={h.employeeHoursVisibility}
                  onChange={(e) =>
                    setVis.mutate(
                      { id: h.id, employeeHoursVisibility: e.target.value },
                      {
                        onSuccess: () => {
                          toast(t('Gespeichert.'));
                          void hotels.refetch();
                        },
                      },
                    )
                  }
                >
                  <option value="after_approval">{t('nach Freigabe')}</option>
                  <option value="immediately">{t('sofort')}</option>
                </select>
              </label>
            )}
          </div>
          {me?.role !== 'manager' && <HotelPlatformSettings hotelId={h.id} />}
          <table className="table">
            <thead>
              <tr>
                <th style={{ paddingLeft: 'var(--space-4)' }}>{t('Abteilung')}</th>
                <th>{t('Schichten')}</th>
                <th style={{ width: 170 }}>{t('Mindestbesetzung')}</th>
                <th style={{ width: 300 }} />
              </tr>
            </thead>
            <tbody>
              {(depts.data?.items ?? [])
                .filter((d: any) => d.hotelId === h.id)
                .map((d: any) => (
                  <tr key={d.id}>
                    <td style={{ paddingLeft: 'var(--space-4)', fontWeight: 700 }}>{d.name}</td>
                    <td style={{ fontSize: 13 }}>
                      {(shifts.data?.items ?? [])
                        .filter((x: any) => x.departmentId === d.id)
                        .map((x: any) => `${x.name} ${x.startTime}–${x.endTime}`)
                        .join(' · ') || '–'}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {minimums(shifts.data?.items ?? [], d.id)}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="btn btn-ghost"
                        onClick={() => setDlg({ kind: 'shifts', hotelId: h.id, dept: d })}
                      >
                        {t('Schichten & Besetzung')}
                      </button>
                      {me?.role !== 'manager' && (
                        <>
                          <button
                            className="btn btn-ghost"
                            onClick={() => setDlg({ kind: 'dept', hotelId: h.id, dept: d })}
                          >
                            {t('Bearbeiten')}
                          </button>
                          <button
                            className="btn btn-ghost"
                            onClick={() =>
                              window.confirm(t('Abteilung löschen?')) &&
                              delDept.mutate(d.id, { onSuccess: () => void depts.refetch() })
                            }
                          >
                            {t('Löschen')}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          {me?.role !== 'manager' && (
            <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
              <button className="btn btn-secondary" onClick={() => setDlg({ kind: 'dept', hotelId: h.id })}>
                {t('Abteilung hinzufügen')}
              </button>
            </div>
          )}
        </section>
      ))}
      <ErrorNote error={delDept.error} />
      {dlg?.kind === 'hotel' && (
        <HotelDialog
          companies={companies.data?.items ?? []}
          onClose={() => setDlg(null)}
          onDone={() => {
            setDlg(null);
            void hotels.refetch();
          }}
        />
      )}
      {dlg?.kind === 'shifts' && (
        <ShiftsDialog
          hotelId={dlg.hotelId}
          dept={dlg.dept}
          shifts={(shifts.data?.items ?? []).filter((x: any) => x.departmentId === dlg.dept.id)}
          onClose={() => setDlg(null)}
          onChanged={() => void shifts.refetch()}
        />
      )}
      {dlg?.kind === 'dept' && (
        <DeptDialog
          hotelId={dlg.hotelId}
          dept={dlg.dept}
          onClose={() => setDlg(null)}
          onDone={() => {
            setDlg(null);
            void depts.refetch();
          }}
        />
      )}
    </div>
  );
}

function HotelDialog({
  companies,
  onClose,
  onDone,
}: {
  companies: any[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [f, setF] = useState({
    companyId: companies[0]?.id ?? 0,
    name: '',
    city: '',
    federalState: 'HE',
    timezone: 'Europe/Berlin',
  });
  const m = useSend('POST', '/hotels');
  return (
    <Dialog
      title={t('Hotel anlegen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!f.name}
            onClick={() => m.mutate({ ...f, companyId: Number(f.companyId) }, { onSuccess: onDone })}
          >
            {t('Speichern')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Unternehmen')} htmlFor="co">
        <select
          id="co"
          className="input"
          value={f.companyId}
          onChange={(e) => setF({ ...f, companyId: Number(e.target.value) })}
        >
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('Name')} htmlFor="hn">
        <input
          id="hn"
          className="input"
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
        />
      </Field>
      <Field label={t('Stadt')} htmlFor="hc">
        <input
          id="hc"
          className="input"
          value={f.city}
          onChange={(e) => setF({ ...f, city: e.target.value })}
        />
      </Field>
      <Field label={t('Bundesland (Kürzel)')} htmlFor="hs">
        <input
          id="hs"
          className="input"
          maxLength={2}
          value={f.federalState}
          onChange={(e) => setF({ ...f, federalState: e.target.value.toUpperCase() })}
        />
      </Field>
      <Field label={t('Zeitzone')} htmlFor="tz">
        <input
          id="tz"
          className="input"
          value={f.timezone}
          onChange={(e) => setF({ ...f, timezone: e.target.value })}
        />
      </Field>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}

function DeptDialog({
  hotelId,
  dept,
  onClose,
  onDone,
}: {
  hotelId: number;
  dept?: any;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(dept?.name ?? '');
  const create = useSend('POST', '/departments');
  const update = useSend('PUT', `/departments/${dept?.id}`);
  const m = dept ? update : create;
  return (
    <Dialog
      title={dept ? t('Abteilung bearbeiten') : t('Abteilung hinzufügen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!name}
            onClick={() => m.mutate(dept ? { name } : { hotelId, name }, { onSuccess: onDone })}
          >
            {t('Speichern')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Name')} htmlFor="dn">
        <input id="dn" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- users and roles
export function AdminUsers() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const users = useGet('/users', { q: q || undefined, pageSize: 100 });
  const [dlg, setDlg] = useState(false);
  const roleName = (r: string) =>
    r === 'superAdmin'
      ? 'Super-Admin'
      : r === 'admin'
        ? 'Administration'
        : r === 'manager'
          ? 'Leitung'
          : 'Mitarbeiter';
  return (
    <div
      style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 20, marginRight: 'auto' }}>{t('Benutzer und Rollen')}</h2>
        <input
          className="input"
          style={{ width: 220 }}
          placeholder={t('Name suchen')}
          aria-label={t('Name suchen')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn btn-primary" onClick={() => setDlg(true)}>
          {t('Benutzer einladen')}
        </button>
      </div>
      <div style={{ overflowX: 'auto', border: '2px solid var(--color-text)' }}>
        <table className="table" style={{ minWidth: 760 }}>
          <thead>
            <tr>
              <th style={{ paddingLeft: 'var(--space-4)' }}>{t('Name')}</th>
              <th>{t('Rolle')}</th>
              <th>{t('Zugriff auf Hotels')}</th>
              <th>{t('Letzte Anmeldung')}</th>
              <th>{t('Status')}</th>
            </tr>
          </thead>
          <tbody>
            {(users.data?.items ?? []).map((u: any) => (
              <tr key={u.userId} style={{ opacity: u.status === 'disabled' ? 0.5 : 1 }}>
                <td style={{ paddingLeft: 'var(--space-4)' }}>
                  <div style={{ fontWeight: 700 }}>{u.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-neutral-700)' }}>{u.login}</div>
                </td>
                <td>{u.roles.map((r: any) => t(roleName(r.role))).join(', ')}</td>
                <td>
                  {u.roles
                    .flatMap((r: any) =>
                      r.hotelNames.length ? r.hotelNames : r.companyName ? [r.companyName] : [],
                    )
                    .join(', ')}
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {u.lastLoginAt ? fdate(u.lastLoginAt) : t('nie')}
                </td>
                <td>
                  <span className={`tag ${u.status === 'active' ? 'tag-accent' : 'tag-neutral'}`}>
                    {t(
                      u.status === 'active'
                        ? 'Aktiv'
                        : u.status === 'pending_invite'
                          ? 'Einladung offen'
                          : 'Gesperrt',
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
        {t('Neue Benutzer erhalten einen Einladungslink und legen ihr Passwort selbst fest.')}
      </div>
      {dlg && (
        <InviteDialog
          onClose={() => setDlg(false)}
          onDone={() => {
            setDlg(false);
            void users.refetch();
          }}
        />
      )}
    </div>
  );
}

function InviteDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const hotels = useGet('/hotels');
  const companies = useGet('/companies');
  const [kind, setKind] = useState<'manager' | 'admin'>('manager');
  const [f, setF] = useState({ email: '', firstName: '', lastName: '' });
  const [sel, setSel] = useState<number[]>([]);
  const m = useSend('POST', kind === 'manager' ? '/managers' : '/admins');
  const list: any[] = kind === 'manager' ? (hotels.data?.items ?? []) : (companies.data?.items ?? []);
  useEffect(() => setSel([]), [kind]);
  return (
    <Dialog
      title={t('Benutzer einladen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!f.email || !f.firstName || !f.lastName || !sel.length}
            onClick={() =>
              m.mutate(
                { ...f, ...(kind === 'manager' ? { hotelIds: sel } : { companyIds: sel }) },
                { onSuccess: onDone },
              )
            }
          >
            {t('Einladen')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      {me?.role === 'superAdmin' && (
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: 'manager', label: t('Leitung') },
            { value: 'admin', label: t('Administration') },
          ]}
        />
      )}
      <Field label={t('Vorname')} htmlFor="iv1">
        <input
          id="iv1"
          className="input"
          value={f.firstName}
          onChange={(e) => setF({ ...f, firstName: e.target.value })}
        />
      </Field>
      <Field label={t('Nachname')} htmlFor="iv2">
        <input
          id="iv2"
          className="input"
          value={f.lastName}
          onChange={(e) => setF({ ...f, lastName: e.target.value })}
        />
      </Field>
      <Field label={t('E-Mail')} htmlFor="iv3">
        <input
          id="iv3"
          type="email"
          className="input"
          value={f.email}
          onChange={(e) => setF({ ...f, email: e.target.value })}
        />
      </Field>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontSize: 12, marginBottom: 5 }}>
          {kind === 'manager' ? t('Zugriff auf Hotels') : t('Unternehmen')}
        </legend>
        {list.map((x) => (
          <label key={x.id} style={{ display: 'flex', gap: 8, fontSize: 14, padding: '3px 0' }}>
            <input
              type="checkbox"
              checked={sel.includes(x.id)}
              onChange={(e) => setSel(e.target.checked ? [...sel, x.id] : sel.filter((i) => i !== x.id))}
            />{' '}
            {x.name}
          </label>
        ))}
      </fieldset>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- companies (super admin)
export function AdminCompanies() {
  const { t } = useTranslation();
  const companies = useGet('/companies');
  const hotels = useGet('/hotels');
  const admins = useGet('/admins');
  const [name, setName] = useState('');
  const create = useSend('POST', '/companies');
  const [adm, setAdm] = useState(false);
  return (
    <div
      style={{
        padding: 'var(--space-4)',
        display: 'grid',
        gap: 'var(--space-4)',
        gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))',
      }}
    >
      <section>
        <SectionTitle>{t('Unternehmen')}</SectionTitle>
        {(companies.data?.items ?? []).map((c: any) => (
          <div key={c.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--color-divider)' }}>
            <b>{c.name}</b>
            <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
              {t('Toleranz')} {c.graceMinutes} min · {t('PIN-Länge')} {c.pinLength} ·{' '}
              {(hotels.data?.items ?? [])
                .filter((h: any) => h.companyId === c.id)
                .map((h: any) => h.name)
                .join(', ')}
            </div>
          </div>
        ))}
        <form
          style={{ display: 'flex', gap: 8, marginTop: 'var(--space-3)' }}
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(
              { name },
              {
                onSuccess: () => {
                  setName('');
                  void companies.refetch();
                },
              },
            );
          }}
        >
          <input
            className="input"
            placeholder={t('Name des Unternehmens')}
            aria-label={t('Name des Unternehmens')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn btn-primary" disabled={!name}>
            {t('Unternehmen anlegen')}
          </button>
        </form>
        <ErrorNote error={create.error} />
      </section>
      <section>
        <SectionTitle>{t('Administration')}</SectionTitle>
        {(admins.data?.items ?? []).map((a: any) => (
          <div key={a.adminId} style={{ padding: '8px 0', borderBottom: '1px solid var(--color-divider)' }}>
            <b>
              {a.firstName} {a.lastName}
            </b>{' '}
            <span style={{ fontSize: 12 }}>{a.email}</span>
            <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
              {(companies.data?.items ?? [])
                .filter((c: any) => a.companyIds.includes(c.id))
                .map((c: any) => c.name)
                .join(', ')}
            </div>
          </div>
        ))}
        <button
          className="btn btn-secondary"
          style={{ marginTop: 'var(--space-3)' }}
          onClick={() => setAdm(true)}
        >
          {t('Benutzer einladen')}
        </button>
        {adm && (
          <InviteDialog
            onClose={() => setAdm(false)}
            onDone={() => {
              setAdm(false);
              void admins.refetch();
            }}
          />
        )}
      </section>
    </div>
  );
}

void api;
void Kicker;

/** Weekday and weekend minimum of a department: sum over its shifts (Mo / Sa defaults). */
function minimums(shifts: any[], deptId: number): string {
  const mine = shifts.filter((x) => x.departmentId === deptId);
  if (!mine.length) return '–';
  const sum = (wd: string) => mine.reduce((a, x) => a + (x.weekdayDefaults[wd] ?? 0), 0);
  return `${sum('1')} · ${sum('6')}`;
}

const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function ShiftEditor({
  hotelId,
  deptId,
  shift,
  onDone,
}: {
  hotelId: number;
  deptId: number;
  shift?: any;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({
    name: shift?.name ?? '',
    startTime: shift?.startTime ?? '06:00',
    endTime: shift?.endTime ?? '14:00',
    breakMinutes: String(shift?.breakMinutes ?? 30),
    requiredQualificationId: String(shift?.requiredQualificationId ?? ''),
  });
  const quals = useGet('/qualifications');
  const [wd, setWd] = useState<Record<string, string>>(
    Object.fromEntries(
      WD.map((_, i) => [String(i + 1), String(shift?.weekdayDefaults?.[String(i + 1)] ?? '')]),
    ),
  );
  const [ov, setOv] = useState<Array<{ date: string; count: string }>>(
    (shift?.overrides ?? []).map((o: any) => ({ date: o.date, count: String(o.count) })),
  );
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setError(null);
    try {
      const base = {
        name: f.name,
        startTime: f.startTime,
        endTime: f.endTime,
        breakMinutes: Number(f.breakMinutes) || 0,
        requiredQualificationId: f.requiredQualificationId ? Number(f.requiredQualificationId) : null,
      };
      const saved = shift
        ? await api(`/shifts/${shift.id}`, { method: 'PUT', body: base })
        : await api('/shifts', { body: { ...base, hotelId, departmentId: deptId } });
      await api(`/shifts/${saved.id}/staffing`, {
        method: 'PUT',
        body: {
          weekdayDefaults: Object.fromEntries(
            Object.entries(wd)
              .filter(([, v]) => v !== '')
              .map(([k, v]) => [k, Number(v)]),
          ),
          overrides: ov
            .filter((o) => o.date && o.count !== '')
            .map((o) => ({ date: o.date, count: Number(o.count) })),
        },
      });
      toast(t('Gespeichert.'));
      onDone();
    } catch (e) {
      setError(e);
    }
  };
  const remove = async () => {
    if (!shift || !window.confirm(t('Schicht löschen?'))) return;
    try {
      await api(`/shifts/${shift.id}`, { method: 'DELETE' });
      onDone();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div
      style={{
        border: '2px solid var(--color-text)',
        padding: 'var(--space-3)',
        display: 'grid',
        gap: 'var(--space-3)',
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 'var(--space-2)' }}>
        <Field label={t('Name')}>
          <input
            className="input"
            aria-label={t('Name')}
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
        </Field>
        <Field label={t('Beginn')}>
          <input
            className="input"
            placeholder="HH:mm"
            maxLength={5}
            aria-label={t('Beginn')}
            value={f.startTime}
            onChange={(e) => setF({ ...f, startTime: e.target.value })}
          />
        </Field>
        <Field label={t('Ende')}>
          <input
            className="input"
            placeholder="HH:mm"
            maxLength={5}
            aria-label={t('Ende')}
            value={f.endTime}
            onChange={(e) => setF({ ...f, endTime: e.target.value })}
          />
        </Field>
        <Field label={t('Pause (Min.)')}>
          <input
            className="input"
            inputMode="numeric"
            aria-label={t('Pause (Min.)')}
            value={f.breakMinutes}
            onChange={(e) => setF({ ...f, breakMinutes: e.target.value })}
          />
        </Field>
      </div>
      {(quals.data?.items ?? []).length > 0 && (
        <Field label={t('Erforderliche Qualifikation')} htmlFor="sh-qual">
          <select
            id="sh-qual"
            className="input"
            value={f.requiredQualificationId}
            onChange={(e) => setF({ ...f, requiredQualificationId: e.target.value })}
          >
            <option value="">{t('Keine')}</option>
            {quals.data.items.map((q: any) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div>
        <div style={{ fontSize: 12, marginBottom: 4 }}>{t('Mindestbesetzung pro Wochentag')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
          {WD.map((d, i) => (
            <label key={d} style={{ fontSize: 11, textAlign: 'center' }}>
              {t(d)}
              <input
                className="input"
                style={{ textAlign: 'center', padding: '2px 4px' }}
                inputMode="numeric"
                value={wd[String(i + 1)]}
                onChange={(e) => setWd({ ...wd, [String(i + 1)]: e.target.value })}
              />
            </label>
          ))}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 12, marginBottom: 4 }}>{t('Abweichungen an einzelnen Tagen')}</div>
        {ov.map((o, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
            <input
              className="input"
              type="date"
              aria-label={t('Datum')}
              value={o.date}
              onChange={(e) => setOv(ov.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))}
            />
            <input
              className="input"
              style={{ width: 80 }}
              inputMode="numeric"
              aria-label={t('Anzahl')}
              value={o.count}
              onChange={(e) => setOv(ov.map((x, j) => (j === i ? { ...x, count: e.target.value } : x)))}
            />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setOv(ov.filter((_, j) => j !== i))}
            >
              {t('Entfernen')}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setOv([...ov, { date: '', count: '' }])}
        >
          {t('Tag hinzufügen')}
        </button>
      </div>
      <ErrorNote error={error} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" disabled={!f.name} onClick={() => void save()}>
          {t('Speichern')}
        </button>
        {shift && (
          <button className="btn btn-ghost" onClick={() => void remove()}>
            {t('Löschen')}
          </button>
        )}
      </div>
    </div>
  );
}

function ShiftsDialog({
  hotelId,
  dept,
  shifts,
  onClose,
  onChanged,
}: {
  hotelId: number;
  dept: any;
  shifts: any[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  return (
    <Dialog
      title={`${dept.name}: ${t('Schichten & Besetzung')}`}
      onClose={onClose}
      width={720}
      actions={
        <button className="btn btn-secondary" onClick={onClose}>
          {t('Schließen')}
        </button>
      }
    >
      {shifts.map((x) => (
        <ShiftEditor
          key={`${x.id}-${JSON.stringify(x)}`}
          hotelId={hotelId}
          deptId={dept.id}
          shift={x}
          onDone={onChanged}
        />
      ))}
      {adding ? (
        <ShiftEditor
          hotelId={hotelId}
          deptId={dept.id}
          onDone={() => {
            setAdding(false);
            onChanged();
          }}
        />
      ) : (
        <button
          className="btn btn-secondary"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setAdding(true)}
        >
          {t('Schicht hinzufügen')}
        </button>
      )}
    </Dialog>
  );
}
