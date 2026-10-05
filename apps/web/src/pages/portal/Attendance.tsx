import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fromZonedTime } from 'date-fns-tz';
import { useGet, useSend } from '../../lib/api';
import { fdate, fnum, ftime } from '../../lib/format';
import { Dialog, ErrorNote, Field, useToast } from '../../components/ui';
import { todayIso } from '../planning/util';
import { TZ, card, cardHead, dayLabel, line, stat } from './common';

export const ABS: Record<string, string> = {
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
export const monthOf = (iso: string) => iso.slice(0, 7);
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
