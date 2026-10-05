import type { ApprovalCountDto } from '@dienst/shared';
import { useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PLANNER_NAV } from '../nav';
import { useAuth, homePathFor, type AvailableRole } from '../lib/auth';
import { useGet } from '../lib/api';
import { LangSwitch } from './LangSwitch';
import { roleLabel } from '../pages/Login';

export function AccountMenu() {
  const { t } = useTranslation();
  const { me, logout, switchRole } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  if (!me) return null;
  const others = me.availableRoles.filter(
    (r) => !(r.role === me.role && (r.employeeId ?? null) === me.employeeId),
  );
  const go = async (r: AvailableRole) => {
    await switchRole(r.role, r.employeeId);
    setOpen(false);
    nav(homePathFor(r.role));
  };
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{
          border: 0,
          background: 'transparent',
          cursor: 'pointer',
          fontSize: 13,
          color: 'var(--color-neutral-700)',
        }}
      >
        {me.displayName} · {t(roleLabel(me.role))} ▾
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            zIndex: 60,
            minWidth: 240,
            background: 'var(--color-bg)',
            border: '2px solid var(--color-text)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {others.map((r) => (
            <button
              key={`${r.role}-${r.employeeId ?? ''}`}
              role="menuitem"
              onClick={() => void go(r)}
              style={menuBtn}
            >
              {t('Rolle wechseln')}: {t(roleLabel(r.role))} {r.companyName ? `· ${r.companyName}` : ''}
            </button>
          ))}
          <button
            role="menuitem"
            onClick={async () => {
              await logout();
              nav('/login');
            }}
            style={menuBtn}
          >
            {t('Abmelden')}
          </button>
        </div>
      )}
    </div>
  );
}

const menuBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '9px 12px',
  border: 0,
  borderBottom: '1px solid var(--color-divider)',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 13,
};

export function PlannerShell() {
  const { t } = useTranslation();
  const loc = useLocation();
  const nav = useNavigate();
  const section =
    PLANNER_NAV.find((s) =>
      s.items.some((i) => loc.pathname.startsWith(i.path.split('/').slice(0, 2).join('/'))),
    ) ?? PLANNER_NAV[0];
  const { me } = useAuth();
  const count = useGet<ApprovalCountDto>('/approvals/count', undefined, { refetchInterval: 30_000 });
  const open: number = count.data?.total ?? 0;
  const sections = me?.role === 'manager' ? PLANNER_NAV.filter((s) => s.key !== 'admin') : PLANNER_NAV;
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
          {sections.map((s) => {
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
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            fontSize: 13,
            flexWrap: 'wrap',
          }}
        >
          <LangSwitch />
          <AccountMenu />
        </div>
      </header>
      {section.items.length > 1 && (
        <div
          data-noprint
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
                {si.path === '/requests' && open > 0 && (
                  <span
                    data-testid="inbox-badge"
                    aria-label={`${open} ${t('offen')}`}
                    style={{
                      marginLeft: 6,
                      fontSize: 11,
                      fontWeight: 800,
                      padding: '1px 6px',
                      background: 'var(--color-accent)',
                      color: 'var(--color-bg)',
                    }}
                  >
                    {open}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Outlet />
      </div>
    </div>
  );
}
