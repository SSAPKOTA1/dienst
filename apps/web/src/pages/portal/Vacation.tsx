import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../../lib/api';
import { fdate, fnum } from '../../lib/format';
import { Dialog, ErrorNote, Field, useToast } from '../../components/ui';
import { todayIso } from '../planning/util';
import { card, line, stat } from './common';
import { PortalNotices, PortalWishes } from './Account';

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
