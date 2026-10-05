import { useState } from 'react';
import { NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useGet } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fdatetime } from '../../lib/format';
import { PageHead, SectionTitle } from '../../components/ui';
import { ClosePeriods } from '../AdminMore';

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
              aria-label={t('Einrichtung')}
              aria-valuemin={0}
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
