import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fromZonedTime } from 'date-fns-tz';
import { download, useGet, useSend } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fdate, fnum, fsigned, ftime } from '../lib/format';
import { Dialog, ErrorNote, Field, useToast } from '../components/ui';
import { AccountMenu } from '../components/Shell';
import { LedgerTable } from '../components/Ledger';
import { PortalExtras } from './PortalExtras';
import { LangSwitch } from '../components/LangSwitch';
import { addDaysIso, mondayOfIso, todayIso, weekRangeLabel } from './planning/util';

const TZ = 'Europe/Berlin';
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

const card: React.CSSProperties = {
  border: '2px solid var(--color-text)',
  margin: 'var(--space-3)',
  background: 'var(--color-bg)',
};
const cardHead: React.CSSProperties = {
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
const stat = (label: string, value: React.ReactNode) => (
  <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
    <div
      style={{
        fontSize: 11,
        letterSpacing: '.08em',
        textTransform: 'uppercase',
        color: 'var(--color-neutral-700)',
      }}
    >
      {label}
    </div>
    <div style={{ fontSize: 26, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
  </div>
);
const dayLabel = (iso: string) => fdate(iso, { weekday: 'short', day: '2-digit', month: '2-digit' });

const NOTE_TEXT = (n: any, t: (s: string) => string): string => {
  const p = n.payload ?? {};
  const verdict = p.decision === 'approve' ? t('freigegeben') : t('abgelehnt');
  switch (n.kind) {
    case 'schedule_published':
      return t('Neuer Dienstplan veröffentlicht');
    case 'schedule_changed':
      return t('Dein Dienstplan wurde geändert');
    case 'approval_decision':
      return p.timeOffId
        ? `${t('Dein Urlaubsantrag wurde')} ${verdict}`
        : p.correctionId
          ? `${t('Deine Korrektur wurde')} ${verdict}`
          : `${t('Deine Zeit wurde')} ${verdict}`;
    case 'auto_checkout':
      return t('Du wurdest automatisch ausgestempelt');
    case 'swap_offered':
      return t('Dir wurde eine Schicht zum Tausch angeboten');
    case 'swap_accepted':
      return t('Dein Tauschangebot wurde angenommen');
    case 'swap_declined':
      return t('Dein Tauschangebot wurde abgelehnt');
    case 'swap_decision':
      return `${t('Dein Schichttausch wurde')} ${p.decision === 'approved' ? t('genehmigt') : t('abgelehnt')}`;
    case 'swap_expired':
      return t('Dein Tauschangebot ist abgelaufen');
    case 'open_shift_decision':
      return `${t('Deine Bewerbung auf eine offene Schicht wurde')} ${p.decision === 'approved' ? t('angenommen') : t('abgelehnt')}`;
    case 'announcement':
      return `${t('Neue Mitteilung')}: ${p.title ?? ''}`;
    case 'question_answered':
      return t('Die Leitung hat deine Frage beantwortet');
    case 'wish_decision':
      return `${t('Dein Wunsch wurde')} ${p.decision === 'granted' ? t('erfüllt') : t('abgelehnt')}`;
    case 'vacation_notice':
      return t('Hinweis zu deinem Resturlaub');
    default:
      return n.kind;
  }
};

// ---------------------------------------------------------------- home
export function PortalHome() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const home = useGet('/me/home');
  const read = useSend<number>('PUT', (id) => `/notifications/${id}/read`, [['api', '/me/home']]);
  const h = home.data;
  const first = me?.displayName?.split(' ')[0] ?? '';
  return (
    <main>
      <div style={{ padding: 'var(--space-3) var(--space-3) 0' }}>
        <div
          style={{
            fontSize: 11,
            letterSpacing: '.1em',
            textTransform: 'uppercase',
            color: 'var(--color-accent-700)',
          }}
        >
          {h ? fdate(h.today, { weekday: 'long', day: 'numeric', month: 'long' }) : ''}
        </div>
        <h1 style={{ margin: '2px 0 0', fontSize: 28 }}>
          {t('Hallo')} {first}
        </h1>
        {h?.clockedIn && (
          <div role="status" style={{ marginTop: 6, fontSize: 13, fontWeight: 700 }}>
            ● {t('Du bist eingestempelt.')}
          </div>
        )}
      </div>
      <section style={card} aria-labelledby="h-next">
        <h2 id="h-next" style={cardHead}>
          {t('Nächste Schichten')}
        </h2>
        {(h?.nextShifts ?? []).length === 0 && <div style={line}>{t('Keine Schichten geplant.')}</div>}
        {(h?.nextShifts ?? []).map((s: any) => (
          <div
            key={s.id}
            style={{ ...line, display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline' }}
            data-testid="next-shift"
          >
            <b style={{ minWidth: 92 }}>{dayLabel(s.date)}</b>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {ftime(s.start, TZ)}–{ftime(s.end, TZ)}
            </span>
            <span style={{ color: 'var(--color-neutral-700)', marginLeft: 'auto', fontSize: 12 }}>
              {s.shiftName ?? s.hotelName}
            </span>
          </div>
        ))}
      </section>
      <section style={card} aria-labelledby="h-week">
        <h2 id="h-week" style={cardHead}>
          {t('Diese Woche')}
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)' }}>
          {stat(t('Gearbeitet (freigegeben)'), `${fnum(h?.weekHours)} h`)}
          {stat(t('Geplant'), `${fnum(h?.weekPlannedHours)} h`)}
          {h?.targetHours != null && stat(t('Soll'), `${fnum(h.targetHours)} h`)}
        </div>
      </section>
      <div
        style={{ ...card, display: 'grid', gridTemplateColumns: h?.timeAccount != null ? '1fr 1fr' : '1fr' }}
      >
        {stat(t('Resturlaub'), `${fnum(h?.vacation?.remaining)} ${t('Tage')}`)}
        {h?.timeAccount != null && stat(t('Arbeitszeitkonto'), fsigned(h.timeAccount))}
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', margin: '0 var(--space-3)', flexWrap: 'wrap' }}>
        <NavLink className="btn btn-primary" to="/me/vacation?new=1">
          {t('Urlaub beantragen')}
        </NavLink>
        <NavLink className="btn btn-secondary" to="/me/attendance?correct=1">
          {t('Stempelzeit korrigieren')}
        </NavLink>
      </div>
      <section style={card} aria-labelledby="h-notes">
        <h2 id="h-notes" style={cardHead}>
          {t('Benachrichtigungen')}
        </h2>
        {(h?.notifications ?? []).length === 0 && <div style={line}>{t('Keine Benachrichtigungen.')}</div>}
        {(h?.notifications ?? []).map((n: any) => (
          <div
            key={n.id}
            style={{ ...line, display: 'flex', gap: 8, alignItems: 'center', fontWeight: n.read ? 400 : 700 }}
          >
            <span style={{ marginRight: 'auto' }}>{NOTE_TEXT(n, t)}</span>
            {!n.read && (
              <button className="btn btn-ghost" onClick={() => read.mutate(n.id)}>
                {t('Gelesen')}
              </button>
            )}
          </div>
        ))}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------- schedule
export function PortalSchedule() {
  const { t } = useTranslation();
  const [week, setWeek] = useState(() => mondayOfIso(todayIso()));
  const to = addDaysIso(week, 6);
  const s = useGet('/me/schedule', { from: week, to });
  const [swap, setSwap] = useState<any | null>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(week, i));
  const today = todayIso();
  return (
    <main>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 'var(--space-3)' }}>
        <button
          className="btn btn-secondary"
          aria-label={t('Vorherige Woche')}
          onClick={() => setWeek(addDaysIso(week, -7))}
        >
          ←
        </button>
        <div style={{ flex: 1, textAlign: 'center', fontWeight: 800 }}>{weekRangeLabel(week, to)}</div>
        <button
          className="btn btn-secondary"
          aria-label={t('Nächste Woche')}
          onClick={() => setWeek(addDaysIso(week, 7))}
        >
          →
        </button>
      </div>
      <section style={card}>
        {days.map((d) => {
          const entries = (s.data?.entries ?? []).filter((e: any) => e.date === d);
          const abs = (s.data?.absences ?? []).filter((a: any) => a.from <= d && a.to >= d);
          return (
            <div
              key={d}
              style={{
                ...line,
                display: 'grid',
                gridTemplateColumns: '96px 1fr',
                gap: 8,
                background: d === today ? 'var(--color-surface)' : undefined,
              }}
              data-testid="sched-day"
            >
              <b>{dayLabel(d)}</b>
              <div>
                {entries.map((e: any) => (
                  <div key={e.id}>
                    <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                      {ftime(e.start, TZ)}–{ftime(e.end, TZ)}
                    </span>{' '}
                    <span style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
                      {e.shiftName ?? ''} · {e.hotelName} · {fnum(e.hours)} h
                    </span>
                    {new Date(e.start) > new Date() && (
                      <button className="btn btn-ghost" data-testid="swap-btn" onClick={() => setSwap(e)}>
                        {t('Tauschen')}
                      </button>
                    )}
                  </div>
                ))}
                {abs.map((a: any) => (
                  <div key={a.id} style={{ fontSize: 13 }}>
                    {t(ABS[a.type] ?? a.type)}
                    {a.status === 'pending' ? ` (${t('beantragt')})` : ''}
                  </div>
                ))}
                {!entries.length && !abs.length && (
                  <span style={{ color: 'var(--color-neutral-700)' }}>{t('frei')}</span>
                )}
              </div>
            </div>
          );
        })}
      </section>
      {swap && (
        <SwapDialog
          entry={swap}
          onClose={() => setSwap(null)}
          onDone={() => {
            setSwap(null);
            void s.refetch();
          }}
        />
      )}
    </main>
  );
}

function SwapDialog({ entry, onClose, onDone }: { entry: any; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [mode, setMode] = useState<'anyone' | 'colleague'>('anyone');
  const [colleague, setColleague] = useState('');
  const [theirs, setTheirs] = useState('');
  const [reason, setReason] = useState('');
  const colleagues = useGet('/me/colleagues');
  const shifts = useGet(colleague ? `/me/colleagues/${colleague}/shifts` : null);
  const send = useSend<any>('POST', '/me/swap-requests');
  return (
    <Dialog
      title={t('Schicht tauschen oder abgeben')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={send.isPending || (mode === 'colleague' && !colleague)}
            data-testid="swap-send"
            onClick={() =>
              send.mutate(
                {
                  scheduleId: entry.id,
                  reason: reason || undefined,
                  ...(mode === 'colleague'
                    ? {
                        counterpartEmployeeId: Number(colleague),
                        counterpartScheduleId: theirs ? Number(theirs) : undefined,
                      }
                    : {}),
                },
                {
                  onSuccess: () => {
                    toast(t('Anfrage gesendet'));
                    onDone();
                  },
                },
              )
            }
          >
            {t('Anfrage senden')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 13 }}>
        {dayLabel(entry.date)} {ftime(entry.start, TZ)}–{ftime(entry.end, TZ)} {entry.shiftName ?? ''}
      </p>
      <Field label={t('An wen?')} htmlFor="sw-mode">
        <select id="sw-mode" className="input" value={mode} onChange={(e) => setMode(e.target.value as any)}>
          <option value="anyone">{t('An alle geeigneten Kolleginnen und Kollegen')}</option>
          <option value="colleague">{t('An eine bestimmte Person')}</option>
        </select>
      </Field>
      {mode === 'colleague' && (
        <>
          <Field label={t('Person')} htmlFor="sw-col">
            <select
              id="sw-col"
              className="input"
              value={colleague}
              onChange={(e) => {
                setColleague(e.target.value);
                setTheirs('');
              }}
            >
              <option value="">–</option>
              {(colleagues.data?.items ?? []).map((c: any) => (
                <option key={c.employeeId} value={c.employeeId}>
                  {c.displayName} · {c.departmentName}
                </option>
              ))}
            </select>
          </Field>
          {colleague && (
            <Field label={t('Dafür deren Schicht übernehmen (optional)')} htmlFor="sw-theirs">
              <select
                id="sw-theirs"
                className="input"
                value={theirs}
                onChange={(e) => setTheirs(e.target.value)}
              >
                <option value="">{t('Keine, nur abgeben')}</option>
                {(shifts.data?.items ?? []).map((x: any) => (
                  <option key={x.id} value={x.id}>
                    {dayLabel(x.date)} {ftime(x.start, TZ)}–{ftime(x.end, TZ)} {x.shiftName ?? ''}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </>
      )}
      <Field label={t('Grund (optional)')} htmlFor="sw-reason">
        <input
          id="sw-reason"
          className="input"
          maxLength={300}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <p style={{ margin: 0, fontSize: 12 }}>
        {t('Die Leitung muss den Tausch freigeben, falls dies nicht automatisch geschieht.')}
      </p>
      <ErrorNote error={send.error} />
    </Dialog>
  );
}
const ABS: Record<string, string> = {
  annual_leave: 'Urlaub',
  sick_leave: 'Krank',
  off_day: 'Frei',
  unpaid_leave: 'Unbezahlter Urlaub',
  comp_time: 'Zeitausgleich',
  special_leave: 'Sonderurlaub',
  child_sick: 'Kind krank',
  training: 'Fortbildung',
  parental_leave: 'Elternzeit',
  maternity_leave: 'Mutterschutz',
  vocational_school: 'Berufsschule',
  rest_day: 'Ersatzruhetag',
  public_holiday: 'Feiertag',
};

// ---------------------------------------------------------------- attendance + corrections
const monthOf = (iso: string) => iso.slice(0, 7);
const monthEnd = (m: string) =>
  new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const shiftMonth = (m: string, n: number) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const CORR_TYPES = [
  ['wrong_time', 'Falsche Zeit'],
  ['missed_out', 'Ausstempeln vergessen'],
  ['missed_in', 'Einstempeln vergessen'],
  ['missing_day', 'Fehlender Tag'],
] as const;

export function PortalAttendance() {
  const { t } = useTranslation();
  const [month, setMonth] = useState(() => monthOf(todayIso()));
  const [dlg, setDlg] = useState<{ rec?: any } | null>(() =>
    new URLSearchParams(window.location.search).get('correct') ? {} : null,
  );
  const att = useGet('/me/attendance', { from: `${month}-01`, to: monthEnd(month) });
  const corr = useGet('/me/corrections');
  const [hist, setHist] = useState<any | null>(null);
  const history = useGet(hist ? `/me/attendance/${hist.id}/history` : null);
  return (
    <main>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 'var(--space-3)' }}>
        <button
          className="btn btn-secondary"
          aria-label={t('Vorheriger Monat')}
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          ←
        </button>
        <div style={{ flex: 1, textAlign: 'center', fontWeight: 800 }}>
          {fdate(`${month}-01`, { month: 'long', year: 'numeric' })}
        </div>
        <button
          className="btn btn-secondary"
          aria-label={t('Nächster Monat')}
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          →
        </button>
      </div>
      <section style={card}>
        {stat(t('Freigegebene Stunden'), `${fnum(att.data?.approvedHours, 2)} h`)}
      </section>
      <div style={{ margin: '0 var(--space-3)' }}>
        <button className="btn btn-secondary" onClick={() => setDlg({})}>
          {t('Stempelzeit korrigieren')}
        </button>
      </div>
      <section style={card} aria-label={t('Zeiten')}>
        {(att.data?.items ?? []).length === 0 && <div style={line}>{t('Keine Zeiten in diesem Monat.')}</div>}
        {(att.data?.items ?? []).map((i: any) => (
          <div key={i.id} style={line} data-testid="att-row">
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <b style={{ minWidth: 92 }}>{dayLabel(i.date)}</b>
              {i.hoursHidden ? (
                <span data-testid="hours-hidden">
                  {i.status === 'rejected' ? t('Abgelehnt') : t('Wartet auf Freigabe')}
                </span>
              ) : (
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {ftime(i.paidStart ?? i.in, TZ)}–{i.out ? ftime(i.paidEnd ?? i.out, TZ) : '…'}
                  {i.paidHours != null && <b> · {fnum(i.paidHours, 2)} h</b>}
                </span>
              )}
              {i.preliminary && (
                <span className="tag tag-neutral" style={{ marginLeft: 'auto' }}>
                  {t('vorläufig')}
                </span>
              )}
              {i.status === 'open' && (
                <span className="tag tag-neutral" style={{ marginLeft: 'auto' }}>
                  {t('eingestempelt')}
                </span>
              )}
              {i.status === 'approved' && (
                <span className="tag tag-accent" style={{ marginLeft: 'auto' }}>
                  {t('freigegeben')}
                </span>
              )}
            </div>
            {i.decisionNote && <div style={{ fontSize: 12 }}>„{i.decisionNote}“</div>}
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              {i.status !== 'open' && (
                <button className="btn btn-ghost" onClick={() => setDlg({ rec: i })}>
                  {t('Korrigieren')}
                </button>
              )}
              <button className="btn btn-ghost" onClick={() => setHist(i)}>
                {t('Verlauf')}
              </button>
            </div>
          </div>
        ))}
      </section>
      <section style={card} aria-labelledby="corr-h">
        <h2 id="corr-h" style={cardHead}>
          {t('Meine Korrekturanträge')}
        </h2>
        {(corr.data?.items ?? []).length === 0 && <div style={line}>{t('Keine Anträge.')}</div>}
        {(corr.data?.items ?? []).map((c: any) => (
          <div key={c.id} style={line}>
            <div style={{ display: 'flex', gap: 8 }}>
              <b>{t(CORR_TYPES.find((x) => x[0] === c.type)?.[1] ?? c.type)}</b>
              <span
                className={`tag ${c.status === 'approved' ? 'tag-accent' : 'tag-neutral'}`}
                style={{ marginLeft: 'auto' }}
              >
                {c.status === 'pending'
                  ? t('offen')
                  : c.status === 'approved'
                    ? t('freigegeben')
                    : t('abgelehnt')}
              </span>
            </div>
            <div style={{ fontSize: 12 }}>
              „{c.reason}“{c.decisionNotes ? ` → ${c.decisionNotes}` : ''}
            </div>
          </div>
        ))}
      </section>
      {dlg && <CorrectionDialog rec={dlg.rec} month={month} onClose={() => setDlg(null)} />}
      {hist && (
        <Dialog
          title={`${t('Verlauf')} ${dayLabel(hist.date)}`}
          onClose={() => setHist(null)}
          actions={
            <button className="btn btn-primary" onClick={() => setHist(null)}>
              {t('Schließen')}
            </button>
          }
        >
          {(history.data?.items ?? []).length === 0 && (
            <div style={{ fontSize: 13 }}>{t('Keine Änderungen sichtbar.')}</div>
          )}
          {(history.data?.items ?? []).map((x: any, k: number) => (
            <div
              key={k}
              style={{ fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--color-divider)' }}
            >
              {x.at
                ? new Intl.DateTimeFormat('de-DE', {
                    timeZone: TZ,
                    dateStyle: 'short',
                    timeStyle: 'short',
                  }).format(new Date(x.at))
                : ''}{' '}
              · {x.change} ({x.by}){x.reason ? ` · „${x.reason}“` : ''}
            </div>
          ))}
        </Dialog>
      )}
    </main>
  );
}

function CorrectionDialog({ rec, month, onClose }: { rec?: any; month: string; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [type, setType] = useState<string>(rec ? 'wrong_time' : 'missing_day');
  const [date, setDate] = useState<string>(rec?.date ?? todayIso());
  const [from, setFrom] = useState(rec?.in ? ftime(rec.paidStart ?? rec.in, TZ) : '');
  const [to, setTo] = useState(rec?.out ? ftime(rec.paidEnd ?? rec.out, TZ) : '');
  const [brk, setBrk] = useState('');
  const [reason, setReason] = useState('');
  const send = useSend<any>('POST', '/me/corrections');
  const iso = (hm: string, after?: string) => {
    let d = fromZonedTime(`${date}T${hm}:00`, TZ);
    if (after && d <= new Date(after)) d = new Date(d.getTime() + 86400000);
    return d.toISOString();
  };
  const needsIn = type === 'missed_in' || type === 'missing_day' || type === 'wrong_time';
  const needsOut =
    type === 'missed_in' || type === 'missing_day' || type === 'missed_out' || type === 'wrong_time';
  const submit = () => {
    const requestedIn = from ? iso(from) : undefined;
    const body: any = { type, reason, requestedBreakMinutes: brk === '' ? undefined : Number(brk) };
    if (rec) body.punchRecordId = rec.id;
    if (needsIn && requestedIn) body.requestedIn = requestedIn;
    if (needsOut && to) body.requestedOut = iso(to, requestedIn);
    send.mutate(body, {
      onSuccess: () => {
        toast(t('Antrag gesendet'));
        onClose();
      },
    });
  };
  void month;
  return (
    <Dialog
      title={t('Stempelzeit korrigieren')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={send.isPending || reason.trim().length < 3}
            onClick={submit}
          >
            {t('Antrag senden')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 13 }}>{t('Die Originalzeiten bleiben gespeichert.')}</p>
      <Field label={t('Art')} htmlFor="c-type">
        <select
          id="c-type"
          className="input"
          value={type}
          disabled={!!rec}
          onChange={(e) => setType(e.target.value)}
        >
          {CORR_TYPES.filter((x) =>
            rec
              ? x[0] === 'wrong_time' || x[0] === 'missed_out'
              : x[0] === 'missed_in' || x[0] === 'missing_day',
          ).map(([k, l]) => (
            <option key={k} value={k}>
              {t(l)}
            </option>
          ))}
        </select>
      </Field>
      {!rec && (
        <Field label={t('Datum')} htmlFor="c-date">
          <input
            id="c-date"
            type="date"
            className="input"
            value={date}
            max={todayIso()}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        {needsIn && (
          <Field label={t('Von')} htmlFor="c-from">
            <input
              id="c-from"
              type="time"
              className="input"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
        )}
        {needsOut && (
          <Field label={t('Bis')} htmlFor="c-to">
            <input
              id="c-to"
              type="time"
              className="input"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
        )}
        <Field label={t('Pause (Min.)')} htmlFor="c-brk">
          <input
            id="c-brk"
            type="number"
            min={0}
            max={600}
            className="input"
            value={brk}
            onChange={(e) => setBrk(e.target.value)}
          />
        </Field>
      </div>
      <Field label={t('Begründung')} htmlFor="c-reason">
        <input
          id="c-reason"
          className="input"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <ErrorNote error={send.error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- vacation
export function PortalVacation() {
  const { t } = useTranslation();
  const toast = useToast();
  const vac = useGet('/me/vacation');
  const reqs = useGet('/me/time-off-requests');
  const [dlg, setDlg] = useState(() => !!new URLSearchParams(window.location.search).get('new'));
  const cancel = useSend<number>('DELETE', (id) => `/me/time-off-requests/${id}`);
  const today = todayIso();
  return (
    <main>
      <section style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(3,1fr)' }}>
        {stat(t('Anspruch'), fnum(vac.data?.allocated))}
        {stat(t('Genommen'), fnum(vac.data?.used))}
        {stat(t('Rest'), fnum(vac.data?.remaining))}
      </section>
      <div style={{ margin: '0 var(--space-3)' }}>
        <button className="btn btn-primary" onClick={() => setDlg(true)}>
          {t('Urlaub beantragen')}
        </button>
      </div>
      <section style={card} aria-label={t('Meine Anträge')}>
        {(reqs.data?.items ?? []).length === 0 && <div style={line}>{t('Keine Anträge.')}</div>}
        {(reqs.data?.items ?? []).map((r: any) => (
          <div key={r.id} style={line} data-testid="vac-row">
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <b>
                {fdate(r.from)} – {fdate(r.to)}
              </b>
              <span style={{ fontSize: 12 }}>
                {r.days} {t('Tage')}
              </span>
              <span
                className={`tag ${r.status === 'approved' ? 'tag-accent' : 'tag-neutral'}`}
                style={{ marginLeft: 'auto' }}
              >
                {t(STATUS[r.status] ?? r.status)}
              </span>
            </div>
            {r.decisionNote && <div style={{ fontSize: 12 }}>„{r.decisionNote}“</div>}
            {(r.status === 'pending' || (r.status === 'approved' && r.from >= today)) && (
              <button
                className="btn btn-ghost"
                onClick={() =>
                  cancel.mutate(r.id, {
                    onSuccess: () => {
                      toast(t('Antrag zurückgezogen'));
                      void vac.refetch();
                    },
                  })
                }
              >
                {t('Zurückziehen')}
              </button>
            )}
          </div>
        ))}
        <ErrorNote error={cancel.error} />
      </section>
      <PortalWishes />
      <PortalNotices />
      {dlg && (
        <RequestDialog
          onClose={() => setDlg(false)}
          onDone={() => {
            setDlg(false);
            void vac.refetch();
            toast(t('Antrag gesendet'));
          }}
        />
      )}
    </main>
  );
}
const STATUS: Record<string, string> = {
  pending: 'offen',
  approved: 'genehmigt',
  rejected: 'abgelehnt',
  cancelled: 'zurückgezogen',
};

function RequestDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [half, setHalf] = useState('');
  const valid = from && to && to >= from;
  const preview = useGet(valid ? '/me/time-off-requests/preview' : null, {
    from,
    to,
    halfDay: half && from === to ? half : undefined,
  });
  const send = useSend<any>('POST', '/me/time-off-requests');
  const p = preview.data;
  return (
    <Dialog
      title={t('Urlaub beantragen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={
              !valid || !p || !p.sufficient || p.days === 0 || (p.issues ?? []).length > 0 || send.isPending
            }
            onClick={() =>
              send.mutate(
                { from, to, reason: reason || undefined, halfDay: half && from === to ? half : undefined },
                { onSuccess: onDone },
              )
            }
          >
            {t('Antrag senden')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label={t('Von')} htmlFor="v-from">
          <input
            id="v-from"
            type="date"
            className="input"
            value={from}
            min={todayIso()}
            onChange={(e) => {
              setFrom(e.target.value);
              if (to < e.target.value) setTo(e.target.value);
            }}
          />
        </Field>
        <Field label={t('Bis')} htmlFor="v-to">
          <input
            id="v-to"
            type="date"
            className="input"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
      </div>
      {p && (
        <div role="status" data-testid="vac-preview" style={{ fontSize: 14, fontWeight: 700 }}>
          {p.days} {t('Urlaubstage')} · {t('Rest')} {fnum(p.remaining)} → {fnum(p.remainingAfter)}
          {!p.sufficient && <div style={{ color: 'var(--warn)' }}>⚠ {t('Nicht genug Resturlaub.')}</div>}
          {p.days === 0 && <div>{t('Keine Arbeitstage im Zeitraum.')}</div>}
        </div>
      )}
      {from === to && (
        <Field label={t('Halber Tag')} htmlFor="v-half">
          <select id="v-half" className="input" value={half} onChange={(e) => setHalf(e.target.value)}>
            <option value="">{t('Ganzer Tag')}</option>
            <option value="morning">{t('Vormittag')}</option>
            <option value="afternoon">{t('Nachmittag')}</option>
          </select>
        </Field>
      )}
      {(p?.issues ?? []).length > 0 && (
        <div
          role="alert"
          data-testid="vac-issues"
          style={{ fontSize: 13, fontWeight: 700, color: 'var(--warn)' }}
        >
          ⚠{' '}
          {t(
            'In diesem Zeitraum ist kein Urlaub möglich oder zu viele Kolleginnen und Kollegen sind abwesend.',
          )}
        </div>
      )}
      <Field label={t('Anmerkung (optional)')} htmlFor="v-reason">
        <input
          id="v-reason"
          className="input"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <ErrorNote error={send.error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- account: time account, timesheet, profile
export function PortalAccount() {
  const { t } = useTranslation();
  const toast = useToast();
  const { me } = useAuth();
  const acc = useGet('/me/time-account');
  const [month, setMonth] = useState(() => monthOf(todayIso()));
  const get = (format: 'pdf' | 'xlsx') =>
    void download('/me/timesheet', { month, format }, `stundenzettel_${month}.${format}`).catch(() =>
      toast(t('Export fehlgeschlagen')),
    );
  return (
    <main>
      <section style={card}>
        <h2 style={cardHead}>{t('Arbeitszeitkonto')}</h2>
        {stat(
          t('Stand'),
          acc.data?.balanceHours == null ? t('kein Zeitkonto') : fsigned(acc.data.balanceHours),
        )}
        {acc.data?.asOf && (
          <div style={{ ...line, fontSize: 12, borderBottom: 0 }}>
            {t('Stand')} {fdate(acc.data.asOf)}
          </div>
        )}
        {acc.data?.balanceHours != null && (
          <div style={{ padding: '0 var(--space-3) var(--space-3)' }}>
            <LedgerTable path="/me/time-account/ledger" />
          </div>
        )}
      </section>
      <section style={card}>
        <h2 style={cardHead}>{t('Stundenzettel')}</h2>
        <div style={{ ...line, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="month"
            className="input"
            aria-label={t('Monat')}
            style={{ width: 'auto' }}
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
          <button className="btn btn-primary" data-testid="my-timesheet-pdf" onClick={() => get('pdf')}>
            PDF
          </button>
          <button className="btn btn-secondary" onClick={() => get('xlsx')}>
            Excel
          </button>
        </div>
        <div style={{ ...line, fontSize: 12, borderBottom: 0 }}>
          {t('Es werden nur freigegebene Zeiten ausgewiesen.')}
        </div>
      </section>
      <PortalExtras />
      <section style={card}>
        <h2 style={cardHead}>{t('Profil')}</h2>
        <div style={line}>{me?.displayName}</div>
        <div style={line}>
          {t('Personalnummer')} {me?.personnelNumber}
        </div>
        <div style={line}>
          {me?.homeHotel} · {me?.companyName}
        </div>
        <div style={{ ...line, borderBottom: 0 }}>{me?.email ?? me?.username}</div>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------- wishes and vacation notices
function PortalWishes() {
  const { t } = useTranslation();
  const leave = useGet('/me/leave-wishes');
  const shift = useGet('/me/shift-wishes');
  const [dlg, setDlg] = useState<'leave' | 'shift' | null>(null);
  const withdraw = useSend<{ kind: string; id: number }>('DELETE', (b) => `/me/${b.kind}-wishes/${b.id}`);
  const st = (s: string) => t(WISH_STATUS[s] ?? s);
  const refresh = () => {
    void leave.refetch();
    void shift.refetch();
  };
  return (
    <section style={card} aria-labelledby="wish-h">
      <h2 id="wish-h" style={cardHead}>
        {t('Meine Wünsche')}
      </h2>
      <div style={{ ...line, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-secondary" onClick={() => setDlg('leave')} data-testid="wish-leave-new">
          {t('Urlaubswunsch')}
        </button>
        <button className="btn btn-secondary" onClick={() => setDlg('shift')} data-testid="wish-shift-new">
          {t('Schichtwunsch')}
        </button>
      </div>
      {[
        ...(leave.data?.items ?? []).map((w: any) => ({ ...w, kind: 'leave' })),
        ...(shift.data?.items ?? []).map((w: any) => ({ ...w, kind: 'shift' })),
      ].map((w) => (
        <div key={`${w.kind}${w.id}`} style={line} data-testid="wish-row">
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <b>{w.kind === 'leave' ? `${fdate(w.from)} – ${fdate(w.to)}` : fdate(w.date)}</b>
            <span
              className={`tag ${w.status === 'granted' ? 'tag-accent' : 'tag-neutral'}`}
              style={{ marginLeft: 'auto' }}
            >
              {st(w.status)}
            </span>
          </div>
          {w.decisionNote && <div style={{ fontSize: 12 }}>„{w.decisionNote}“</div>}
          {w.status === 'pending' && (
            <button
              className="btn btn-ghost"
              onClick={() => withdraw.mutate({ kind: w.kind, id: w.id }, { onSuccess: refresh })}
            >
              {t('Zurückziehen')}
            </button>
          )}
        </div>
      ))}
      {dlg && (
        <WishDialog
          kind={dlg}
          onClose={() => setDlg(null)}
          onDone={() => {
            setDlg(null);
            refresh();
          }}
        />
      )}
    </section>
  );
}
const WISH_STATUS: Record<string, string> = {
  pending: 'offen',
  granted: 'erfüllt',
  declined: 'abgelehnt',
  withdrawn: 'zurückgezogen',
};

function WishDialog({
  kind,
  onClose,
  onDone,
}: {
  kind: 'leave' | 'shift';
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const shifts = useGet(kind === 'shift' ? '/me/shifts' : null);
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [shiftId, setShiftId] = useState('');
  const [priority, setPriority] = useState('2');
  const [reason, setReason] = useState('');
  const send = useSend<any>('POST', kind === 'leave' ? '/me/leave-wishes' : '/me/shift-wishes');
  const first = shifts.data?.items?.[0]?.id;
  return (
    <Dialog
      title={kind === 'leave' ? t('Urlaubswunsch') : t('Schichtwunsch')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={send.isPending}
            onClick={() =>
              send.mutate(
                kind === 'leave'
                  ? { from, to, priority: Number(priority), reason: reason || undefined }
                  : {
                      date: from,
                      shiftId: Number(shiftId || first),
                      priority: Number(priority),
                      reason: reason || undefined,
                    },
                { onSuccess: onDone },
              )
            }
          >
            {t('Wunsch senden')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: kind === 'leave' ? '1fr 1fr' : '1fr', gap: 8 }}>
        <Field label={kind === 'leave' ? t('Von') : t('Datum')} htmlFor="w-from">
          <input
            id="w-from"
            type="date"
            className="input"
            value={from}
            min={todayIso()}
            onChange={(e) => {
              setFrom(e.target.value);
              if (to < e.target.value) setTo(e.target.value);
            }}
          />
        </Field>
        {kind === 'leave' && (
          <Field label={t('Bis')} htmlFor="w-to">
            <input
              id="w-to"
              type="date"
              className="input"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
        )}
      </div>
      {kind === 'shift' && (
        <Field label={t('Schicht')} htmlFor="w-shift">
          <select
            id="w-shift"
            className="input"
            value={shiftId || String(first ?? '')}
            onChange={(e) => setShiftId(e.target.value)}
          >
            {(shifts.data?.items ?? []).map((s: any) => (
              <option key={s.id} value={s.id}>
                {s.hotelName} · {s.name} {s.startTime}–{s.endTime}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={t('Priorität')} htmlFor="w-prio">
        <select id="w-prio" className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="1">{t('hoch')}</option>
          <option value="2">{t('mittel')}</option>
          <option value="3">{t('niedrig')}</option>
        </select>
      </Field>
      <Field label={t('Anmerkung (optional)')} htmlFor="w-reason">
        <input
          id="w-reason"
          className="input"
          value={reason}
          maxLength={300}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <p style={{ margin: 0, fontSize: 12 }}>{t('Ein Wunsch ist keine Zusage; die Planung entscheidet.')}</p>
      <ErrorNote error={send.error} />
    </Dialog>
  );
}

function PortalNotices() {
  const { t } = useTranslation();
  const list = useGet('/me/vacation-notices');
  const ack = useSend<number>('PUT', (id) => `/me/vacation-notices/${id}/ack`);
  const items = list.data?.items ?? [];
  if (!items.length) return null;
  return (
    <section style={card} aria-labelledby="vn-h">
      <h2 id="vn-h" style={cardHead}>
        {t('Hinweise zum Resturlaub')}
      </h2>
      {items.map((n: any) => (
        <div key={n.id} style={line} data-testid="vac-notice">
          <b>{n.year}</b>: {t('Du hast noch')} {fnum(n.remainingDays)}{' '}
          {t('Urlaubstage. Resturlaub verfällt zum 31.3. des Folgejahres, wenn er nicht genommen wird.')}
          {!n.acknowledgedAt && (
            <div>
              <button
                className="btn btn-secondary"
                onClick={() => ack.mutate(n.id, { onSuccess: () => void list.refetch() })}
              >
                {t('Zur Kenntnis genommen')}
              </button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
