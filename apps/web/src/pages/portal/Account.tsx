import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { download, useGet, useSend } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fdate, fnum, fsigned } from '../../lib/format';
import { Dialog, ErrorNote, Field, useToast } from '../../components/ui';
import { LedgerTable } from '../../components/Ledger';
import { PortalExtras } from '../PortalExtras';
import { todayIso } from '../planning/util';
import { card, cardHead, line, stat } from './common';
import { monthOf } from './Attendance';

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
      <section style={card} aria-labelledby="mydata-h">
        <h2 id="mydata-h" style={cardHead}>
          {t('Meine Daten')}
        </h2>
        <div style={{ ...line, display: 'block', fontSize: 14 }}>
          {t('Alle Daten, die über dich gespeichert sind, als Datei herunterladen.')}
        </div>
        <div style={{ padding: 'var(--space-3)' }}>
          <button
            className="btn btn-secondary"
            onClick={() =>
              void download('/me/data-export', {}, 'meine-daten.json').catch(() =>
                toast(t('Export fehlgeschlagen')),
              )
            }
          >
            {t('Meine Daten herunterladen')}
          </button>
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

// ---------------------------------------------------------------- wishes and vacation notices
export function PortalWishes() {
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

export function PortalNotices() {
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
