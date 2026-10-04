import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PLANNER_NAV } from './nav';
import { setLang } from './i18n';

function Shell({ children }: { children: React.ReactNode }) {
  const { t, i18n } = useTranslation();
  const loc = useLocation();
  const nav = useNavigate();
  const section =
    PLANNER_NAV.find((s) =>
      s.items.some((i) => loc.pathname.startsWith(i.path.split('/').slice(0, 2).join('/'))),
    ) ?? PLANNER_NAV[0];
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        className="nav"
        data-noprint
        style={{
          flexWrap: 'wrap',
          gap: 'var(--space-3) var(--space-4)',
          padding: 'var(--space-2) var(--space-4)',
        }}
      >
        <div className="nav-brand" style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
          Trip Inn
          <span style={{ fontWeight: 400, fontSize: 13, color: 'var(--color-neutral-700)' }}>
            {t('Dienstplan & Zeiterfassung')}
          </span>
        </div>
        <nav aria-label={t('Hauptnavigation')} style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {PLANNER_NAV.map((s) => {
            const active = s.key === section.key;
            return (
              <button
                key={s.key}
                onClick={() => nav(s.items[0].path)}
                aria-current={active ? 'page' : undefined}
                style={{
                  fontSize: 13,
                  fontWeight: active ? 700 : 400,
                  padding: '7px 11px',
                  border: 0,
                  background: active ? 'var(--color-text)' : 'transparent',
                  color: active ? 'var(--color-bg)' : 'var(--color-text)',
                  cursor: 'pointer',
                }}
              >
                {t(s.label)}
              </button>
            );
          })}
        </nav>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', fontSize: 13 }}>
          <div
            role="group"
            aria-label={t('Sprache')}
            style={{ display: 'flex', border: '1px solid var(--color-divider)' }}
          >
            {(['de', 'en'] as const).map((l) => {
              const on = i18n.language === l;
              return (
                <button
                  key={l}
                  onClick={() => setLang(l)}
                  aria-pressed={on}
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    padding: '5px 9px',
                    border: 0,
                    cursor: 'pointer',
                    background: on ? 'var(--color-text)' : 'transparent',
                    color: on ? 'var(--color-bg)' : 'var(--color-text)',
                  }}
                >
                  {l.toUpperCase()}
                </button>
              );
            })}
          </div>
        </div>
      </header>
      {section.items.length > 1 && (
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-1)',
            flexWrap: 'wrap',
            padding: '0 var(--space-4)',
            borderBottom: '2px solid var(--color-divider)',
          }}
        >
          {section.items.map((si) => {
            const on = loc.pathname.startsWith(si.path);
            return (
              <button
                key={si.path}
                onClick={() => nav(si.path)}
                style={{
                  fontSize: 14,
                  fontWeight: on ? 800 : 500,
                  padding: '10px 14px',
                  border: 0,
                  borderBottom: `3px solid ${on ? 'var(--color-accent)' : 'transparent'}`,
                  marginBottom: -2,
                  background: 'transparent',
                  color: 'var(--color-text)',
                  cursor: 'pointer',
                }}
              >
                {t(si.label)}
              </button>
            );
          })}
        </div>
      )}
      <main style={{ flex: 1, padding: 'var(--space-4)' }}>{children}</main>
    </div>
  );
}

const Placeholder = ({ title }: { title: string }) => {
  const { t } = useTranslation();
  return <h1 style={{ fontSize: 30 }}>{t(title)}</h1>;
};

export function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to="/planning" replace />} />
        <Route path="/planning" element={<Placeholder title="Dienstplan" />} />
        <Route path="/live" element={<Placeholder title="Live" />} />
        <Route path="/requests" element={<Placeholder title="Anträge" />} />
        <Route path="/staff" element={<Placeholder title="Mitarbeiter" />} />
        <Route path="/admin/*" element={<Placeholder title="Einrichtung" />} />
      </Routes>
    </Shell>
  );
}
