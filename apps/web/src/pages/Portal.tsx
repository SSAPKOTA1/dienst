import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fromZonedTime } from 'date-fns-tz';
import { download, useGet, useSend } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fdate, fnum, fsigned, ftime } from '../lib/format';
import { Dialog, ErrorNote, Field, useToast } from '../components/ui';
import { AccountMenu } from '../components/Shell';
import { LangSwitch } from '../components/LangSwitch';
import { addDaysIso, mondayOfIso, todayIso, weekRangeLabel } from './planning/util';

const TZ = 'Europe/Berlin';
const TABS = [
  ['/me', 'Start', true],
  ['/me/schedule', 'Dienstplan', false],
  ['/me/attendance', 'Zeiten', false],
  ['/me/vacation', 'Urlaub', false],
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
          gridTemplateColumns: 'repeat(5,1fr)',
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
    </main>
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
  const valid = from && to && to >= from;
  const preview = useGet(valid ? '/me/time-off-requests/preview' : null, { from, to });
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
            disabled={!valid || !p || !p.sufficient || p.days === 0 || send.isPending}
            onClick={() => send.mutate({ from, to, reason: reason || undefined }, { onSuccess: onDone })}
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
