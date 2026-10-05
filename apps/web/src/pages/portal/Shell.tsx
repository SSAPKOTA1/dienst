import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../lib/auth';
import { AccountMenu } from '../../components/Shell';
import { LangSwitch } from '../../components/LangSwitch';

const TABS = [
  ['/me', 'Start', true],
  ['/me/schedule', 'Dienstplan', false],
  ['/me/attendance', 'Zeiten', false],
  ['/me/vacation', 'Urlaub', false],
  ['/me/team', 'Team', false],
  ['/me/account', 'Konto', false],
] as const;

export function PortalShell() {
  const { t } = useTranslation();
  const { me } = useAuth();
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
      <header
        className="nav"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        <div className="nav-brand" style={{ marginRight: 'auto' }}>
          Trip Inn
          <div style={{ fontWeight: 400, fontSize: 12, color: 'var(--color-neutral-700)' }}>
            {me?.homeHotel}
          </div>
        </div>
        <LangSwitch />
        <AccountMenu />
      </header>
      <div style={{ flex: 1, width: '100%', maxWidth: 640, margin: '0 auto' }}>
        <Outlet />
      </div>
      <nav
        aria-label={t('Hauptnavigation')}
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(6,1fr)',
          background: 'var(--color-bg)',
          borderTop: '2px solid var(--color-text)',
          zIndex: 10,
        }}
      >
        {TABS.map(([to, label, end]) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            style={({ isActive }) => ({
              padding: '14px 4px',
              textAlign: 'center',
              fontSize: 13,
              fontWeight: isActive ? 800 : 500,
              textDecoration: 'none',
              background: isActive ? 'var(--color-text)' : 'transparent',
              color: isActive ? 'var(--color-bg)' : 'var(--color-text)',
            })}
          >
            {t(label)}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
