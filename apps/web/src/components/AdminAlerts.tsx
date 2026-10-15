import type { AdminAlertDto, AdminAlertListDto } from '@dienst/shared';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ApiError, useGet, useSend } from '../lib/api';
import { fdate } from '../lib/format';

const TZ = 'Europe/Berlin';
const hm = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('de-DE', {
        timeZone: TZ,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(iso))
    : '';

/** Short German age, "vor 5 Min." / "vor 3 Std." / date. */
function ago(iso: string | null, t: (k: string) => string): string {
  if (!iso) return '';
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 1) return t('gerade eben');
  if (min < 60) return `${t('vor')} ${min} ${t('Min.')}`;
  if (min < 24 * 60) return `${t('vor')} ${Math.round(min / 60)} ${t('Std.')}`;
  return fdate(iso);
}

const range = (a: AdminAlertDto) =>
  a.from && a.to && a.from !== a.to ? `${fdate(a.from)} – ${fdate(a.to)}` : fdate(a.from ?? a.date);

/** Where an alert is worked on: the Live page for time entries, the plan for a missed shift, the vacation page. */
function target(a: AdminAlertDto): { path: string; label: string } {
  switch (a.kind) {
    case 'late_checkin':
      return { path: `/live?record=${a.refId}`, label: 'Zeiteintrag öffnen' };
    case 'missed_checkout':
      return { path: `/live?record=${a.refId}&close=1`, label: 'Ausstempeln nachtragen' };
    case 'missed_checkin':
      return { path: `/planning?week=${a.date}`, label: 'Im Dienstplan öffnen' };
    case 'new_shift_wish':
      return { path: `/planning?week=${a.date}`, label: 'Im Dienstplan öffnen' };
    case 'new_leave_wish':
      return { path: '/vacation', label: 'Im Urlaubsplan öffnen' };
    default:
      return { path: '/requests', label: 'In den Anträgen öffnen' };
  }
}

function headline(a: AdminAlertDto, t: (k: string) => string): { title: string; detail: string } {
  const who = a.employeeName ?? '–';
  switch (a.kind) {
    case 'late_checkin':
      return {
        title: `${who}: ${t('Verspätet eingestempelt')}`,
        detail: `${a.minutes ?? ''} ${t('Min.')} ${t('nach Schichtbeginn')} (${hm(a.plannedStart)}) · ${fdate(a.date)}`,
      };
    case 'missed_checkin':
      return {
        title: `${who}: ${t('Nicht eingestempelt')}`,
        detail: `${t('Schicht ab')} ${hm(a.plannedStart)} · ${fdate(a.date)}`,
      };
    case 'missed_checkout':
      return {
        title: `${who}: ${t('Nicht ausgestempelt')}`,
        detail: `${t('Schichtende')} ${hm(a.plannedEnd)} · ${fdate(a.date)}`,
      };
    case 'new_shift_wish':
      return { title: `${who}: ${t('Neuer Schichtwunsch')}`, detail: fdate(a.date) };
    case 'new_leave_wish':
      return { title: `${who}: ${t('Neuer Urlaubswunsch')}`, detail: range(a) };
    default:
      return { title: `${who}: ${t('Neuer Urlaubsantrag')}`, detail: range(a) };
  }
}

const STATUS_LABEL: Record<string, string> = {
  approved: 'Genehmigt',
  rejected: 'Abgelehnt',
  cancelled: 'Zurückgezogen',
};

/**
 * Bell in the header of admins and super admins with the unread count and the list of alerts, newest first. The server
 * limits the list to the hotels of the caller; every item can be worked from here (leave requests are decided inline,
 * the others open the Live page, the plan or the vacation page).
 */
export function AdminAlertsBell() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const alerts = useGet<AdminAlertListDto>('/admin-alerts', undefined, { refetchInterval: 30_000 });
  const markRead = useSend<number>('PUT', (id) => `/admin-alerts/${id}/read`);
  const readAll = useSend('PUT', '/admin-alerts/read-all');
  const decide = useSend<{ id: number; decision: 'approve' | 'reject' }>(
    'PUT',
    (b) => `/approvals/absences/${b.id}`,
    [['api']],
  );
  const items = alerts.data?.items ?? [];
  const unread = alerts.data?.unread ?? 0;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const go = (a: AdminAlertDto) => {
    if (!a.read) markRead.mutate(a.id);
    setOpen(false);
    nav(target(a).path);
  };
  const decideLeave = (a: AdminAlertDto, decision: 'approve' | 'reject') => {
    setErr(null);
    decide.mutate(
      { id: a.refId!, decision },
      {
        onSuccess: () => {
          if (!a.read) markRead.mutate(a.id);
        },
        onError: (e) => setErr(e),
      },
    );
  };

  return (
    <div ref={root} style={{ position: 'relative' }} data-noprint>
      <button
        type="button"
        data-testid="alerts-bell"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="admin-alerts-panel"
        aria-label={`${t('Benachrichtigungen')}${unread ? `, ${unread} ${t('ungelesen')}` : ''}`}
        style={{
          border: '2px solid var(--color-text)',
          background: 'transparent',
          cursor: 'pointer',
          padding: '3px 8px',
          fontSize: 13,
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden="true"
        >
          <path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7z" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
        <span>{t('Meldungen')}</span>
        {unread > 0 && (
          <span
            data-testid="alerts-badge"
            style={{
              fontSize: 11,
              fontWeight: 800,
              padding: '1px 6px',
              background: 'var(--color-accent)',
              color: 'var(--color-bg)',
            }}
          >
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div
          id="admin-alerts-panel"
          role="region"
          aria-label={t('Benachrichtigungen')}
          data-testid="alerts-panel"
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            zIndex: 60,
            width: 'min(440px, 92vw)',
            maxHeight: '70vh',
            overflowY: 'auto',
            background: 'var(--color-bg)',
            border: '2px solid var(--color-text)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              padding: '8px 12px',
              borderBottom: '2px solid var(--color-divider)',
              position: 'sticky',
              top: 0,
              background: 'var(--color-bg)',
            }}
          >
            <b style={{ marginRight: 'auto', fontSize: 14 }}>{t('Benachrichtigungen')}</b>
            <button
              className="btn btn-secondary"
              disabled={!unread || readAll.isPending}
              onClick={() => readAll.mutate()}
              data-testid="alerts-read-all"
            >
              {t('Alle als gelesen markieren')}
            </button>
          </div>
          {err && (
            <div
              role="alert"
              style={{ color: 'var(--warn)', fontSize: 13, fontWeight: 600, padding: '6px 12px' }}
            >
              {err.message}
            </div>
          )}
          {items.length === 0 && <div style={{ padding: '12px', fontSize: 13 }}>{t('Keine Meldungen.')}</div>}
          {items.map((a) => {
            const h = headline(a, t);
            const leave = a.kind === 'new_leave_request';
            return (
              <div
                key={a.id}
                data-testid="alert-item"
                data-kind={a.kind}
                style={{
                  padding: '10px 12px',
                  borderBottom: '1px solid var(--color-divider)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  background: a.read ? 'transparent' : 'var(--color-surface)',
                }}
              >
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 14, fontWeight: a.read ? 500 : 800, marginRight: 'auto' }}>
                    {h.title}
                  </span>
                  {!a.read && (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 800,
                        border: '1.5px solid var(--color-text)',
                        padding: '0 5px',
                      }}
                    >
                      {t('Neu')}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
                  {h.detail} · {a.hotelName} · {ago(a.createdAt, t)}
                </div>
                <div
                  style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}
                >
                  {leave && a.open && (
                    <>
                      <button
                        className="btn btn-primary"
                        disabled={decide.isPending}
                        onClick={() => decideLeave(a, 'approve')}
                        data-testid="alert-approve"
                      >
                        {t('Genehmigen')}
                      </button>
                      <button
                        className="btn btn-secondary"
                        disabled={decide.isPending}
                        onClick={() => decideLeave(a, 'reject')}
                        data-testid="alert-reject"
                      >
                        {t('Ablehnen')}
                      </button>
                    </>
                  )}
                  {leave && !a.open && (
                    <span style={{ fontSize: 12, fontWeight: 700 }}>
                      {t(STATUS_LABEL[a.status ?? ''] ?? 'Erledigt')}
                    </span>
                  )}
                  {!leave && !a.open && (
                    <span style={{ fontSize: 12, fontWeight: 700 }}>{t('Erledigt')}</span>
                  )}
                  {a.open && (
                    <button className="btn btn-secondary" onClick={() => go(a)} data-testid="alert-open">
                      {t(target(a).label)}
                    </button>
                  )}
                  {!a.read && (
                    <button
                      className="btn btn-secondary"
                      onClick={() => markRead.mutate(a.id)}
                      data-testid="alert-read"
                    >
                      {t('Gelesen')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
