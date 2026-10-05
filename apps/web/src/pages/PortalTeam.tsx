import type {
  FeaturesDto,
  MyAnnouncementList,
  MyHotelList,
  MyOpenShiftList,
  MyQuestionList,
  MySwapList,
  TeamAbsenceDto,
} from '@dienst/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fdate, fdatetime, ftime } from '../lib/format';
import { Dialog, ErrorNote, Field, useToast } from '../components/ui';
import { FeedBoard } from '../components/Feed';
import { addDaysIso, todayIso } from './planning/util';

const TZ = 'Europe/Berlin';
const card: React.CSSProperties = {
  border: '2px solid var(--color-text)',
  margin: 'var(--space-3)',
  background: 'var(--color-bg)',
};
const head: React.CSSProperties = {
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
const dayLabel = (iso: string) => fdate(iso, { weekday: 'short', day: '2-digit', month: '2-digit' });

/** Portal "Team": announcements, shift offers and open shifts, questions to management, the hotel feed and who is away. */
export function PortalTeam() {
  const { t } = useTranslation();
  const toast = useToast();
  const { me } = useAuth();
  const features = useGet<FeaturesDto>('/me/features');
  const f = features.data ?? {};
  const on = (k: string) => f[k] !== false;
  const ann = useGet<MyAnnouncementList>(on('announcements') ? '/me/announcements' : null);
  const ack = useSend<number>('PUT', (id) => `/me/announcements/${id}/ack`);
  const swaps = useGet<MySwapList>(on('swaps') ? '/me/swap-requests' : null);
  const acceptSwap = useSend<number>('PUT', (id) => `/me/swap-requests/${id}/accept`);
  const declineSwap = useSend<number>('PUT', (id) => `/me/swap-requests/${id}/decline`);
  const cancelSwap = useSend<number>('DELETE', (id) => `/me/swap-requests/${id}`);
  const open = useGet<MyOpenShiftList>(on('open_shifts') ? '/me/open-shifts' : null);
  const claim = useSend<number>('POST', (id) => `/me/open-shifts/${id}/claim`);
  const unclaim = useSend<number>('DELETE', (id) => `/me/open-shifts/${id}/claim`);
  const questions = useGet<MyQuestionList>(on('messages') ? '/me/questions' : null);
  const [ask, setAsk] = useState(false);
  const team = useGet<TeamAbsenceDto>('/me/team-absences', {
    from: todayIso(),
    to: addDaysIso(todayIso(), 30),
  });
  const hotels = useGet<MyHotelList>(on('feed') ? '/me/hotels' : null);
  const err = acceptSwap.error ?? declineSwap.error ?? cancelSwap.error ?? claim.error ?? unclaim.error;
  const done = (msg: string, re: () => unknown) => ({
    onSuccess: () => {
      toast(msg);
      void re();
    },
  });
  const slot = (
    s: { date: string; start: string; end: string; shiftName?: string | null } | null | undefined,
  ) =>
    s
      ? `${dayLabel(s.date)} ${ftime(s.start, TZ)}–${ftime(s.end, TZ)}${s.shiftName ? ` ${s.shiftName}` : ''}`
      : '';
  void me;
  return (
    <main>
      <ErrorNote error={err} />
      {on('announcements') && (
        <section style={card} aria-labelledby="t-ann">
          <h2 id="t-ann" style={head}>
            {t('Mitteilungen')}
          </h2>
          {(ann.data?.items ?? []).length === 0 && <div style={line}>{t('Keine Mitteilungen.')}</div>}
          {(ann.data?.items ?? []).map((a) => (
            <div key={a.id} style={line} data-testid="announcement">
              <b>
                {a.pinned ? '📌 ' : ''}
                {a.title}
              </b>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{a.body}</div>
              {a.requiresAck && !a.acknowledged && (
                <button
                  className="btn btn-secondary"
                  style={{ marginTop: 4 }}
                  data-testid="ann-ack"
                  onClick={() => ack.mutate(a.id, done(t('Bestätigt'), ann.refetch))}
                >
                  {t('Gelesen und verstanden')}
                </button>
              )}
              {a.requiresAck && a.acknowledged && <div style={{ fontSize: 12 }}>✓ {t('Bestätigt')}</div>}
            </div>
          ))}
        </section>
      )}
      {on('swaps') && (swaps.data?.items ?? []).length > 0 && (
        <section style={card} aria-labelledby="t-swap">
          <h2 id="t-swap" style={head}>
            {t('Schichttausch')}
          </h2>
          {(swaps.data?.items ?? [])
            .filter((s) => ['open', 'accepted_by_peer'].includes(s.status) || s.role === 'requester')
            .slice(0, 20)
            .map((s) => (
              <div key={s.id} style={line} data-testid="swap-row">
                <div>
                  <b>{slot(s.slot)}</b>
                  {s.counterpartSlot && <> ⇄ {slot(s.counterpartSlot)}</>}
                </div>
                <div style={{ fontSize: 12 }}>
                  {s.role === 'requester'
                    ? t('Deine Anfrage')
                    : t('Angebot von einer Kollegin oder einem Kollegen')}{' '}
                  · {t(SWAP_STATUS[s.status] ?? s.status)}
                  {s.reason ? ` · „${s.reason}“` : ''}
                </div>
                {s.status === 'open' && s.role !== 'requester' && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    <button
                      className="btn btn-primary"
                      data-testid="swap-accept"
                      onClick={() => acceptSwap.mutate(s.id, done(t('Angenommen'), swaps.refetch))}
                    >
                      {t('Übernehmen')}
                    </button>
                    {s.role === 'counterpart' && (
                      <button
                        className="btn btn-secondary"
                        onClick={() => declineSwap.mutate(s.id, done(t('Abgelehnt'), swaps.refetch))}
                      >
                        {t('Ablehnen')}
                      </button>
                    )}
                  </div>
                )}
                {s.role === 'requester' && ['open', 'accepted_by_peer'].includes(s.status) && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => cancelSwap.mutate(s.id, done(t('Zurückgezogen'), swaps.refetch))}
                  >
                    {t('Zurückziehen')}
                  </button>
                )}
              </div>
            ))}
        </section>
      )}
      {on('open_shifts') && (
        <section style={card} aria-labelledby="t-open">
          <h2 id="t-open" style={head}>
            {t('Offene Schichten')}
          </h2>
          {(open.data?.items ?? []).length === 0 && <div style={line}>{t('Keine offenen Schichten.')}</div>}
          {(open.data?.items ?? []).map((o) => (
            <div
              key={o.id}
              style={{ ...line, display: 'flex', gap: 8, alignItems: 'center' }}
              data-testid="open-shift"
            >
              <span>
                <b>{dayLabel(o.date)}</b> {ftime(o.start, TZ)}–{ftime(o.end, TZ)} {o.shiftName ?? ''}
              </span>
              <span style={{ marginLeft: 'auto' }}>
                {o.claim && o.claim.status === 'pending' ? (
                  <button
                    className="btn btn-secondary"
                    onClick={() => unclaim.mutate(o.id, done(t('Zurückgezogen'), open.refetch))}
                  >
                    {t('Bewerbung zurückziehen')}
                  </button>
                ) : (
                  <button
                    className="btn btn-primary"
                    data-testid="open-claim"
                    onClick={() => claim.mutate(o.id, done(t('Beworben'), open.refetch))}
                  >
                    {t('Bewerben')}
                  </button>
                )}
              </span>
            </div>
          ))}
        </section>
      )}
      {team.data?.enabled && (
        <section style={card} aria-labelledby="t-team">
          <h2 id="t-team" style={head}>
            {t('Im Team abwesend')}
          </h2>
          {team.data.items.length === 0 && <div style={line}>{t('Niemand abwesend.')}</div>}
          {team.data.items.map((x, i) => (
            <div key={i} style={line}>
              <b>{x.displayName}</b> · {fdate(x.from)} – {fdate(x.to)}
            </div>
          ))}
        </section>
      )}
      {on('messages') && (
        <section style={card} aria-labelledby="t-q">
          <h2 id="t-q" style={{ ...head, display: 'flex', alignItems: 'center' }}>
            <span style={{ marginRight: 'auto' }}>{t('Fragen an die Leitung')}</span>
            <button className="btn btn-secondary" onClick={() => setAsk(true)} data-testid="ask-new">
              {t('Frage stellen')}
            </button>
          </h2>
          {(questions.data?.items ?? []).length === 0 && <div style={line}>{t('Noch keine Fragen.')}</div>}
          {(questions.data?.items ?? []).map((q) => (
            <div key={q.id} style={line} data-testid="question-row">
              <b>{q.subject}</b>{' '}
              <span className={`tag ${q.status === 'answered' ? 'tag-accent' : 'tag-neutral'}`}>
                {q.status === 'answered' ? t('beantwortet') : t('offen')}
              </span>
              <div style={{ fontSize: 13 }}>{q.body}</div>
              {q.answer && (
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  → {q.answer} <span style={{ fontSize: 11 }}>({fdatetime(q.answeredAt)})</span>
                </div>
              )}
            </div>
          ))}
        </section>
      )}
      {on('feed') && (hotels.data?.items ?? []).length > 0 && (
        <section style={card} aria-labelledby="t-feed">
          <h2 id="t-feed" style={head}>
            {t('Neuigkeiten')}
          </h2>
          <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
            <FeedBoard hotels={hotels.data?.items ?? []} />
          </div>
        </section>
      )}
      {ask && (
        <AskDialog
          onClose={() => setAsk(false)}
          onDone={() => {
            setAsk(false);
            void questions.refetch();
            toast(t('Frage gesendet'));
          }}
        />
      )}
    </main>
  );
}

const SWAP_STATUS: Record<string, string> = {
  open: 'offen',
  accepted_by_peer: 'wartet auf Freigabe',
  approved: 'genehmigt',
  rejected: 'abgelehnt',
  cancelled: 'zurückgezogen',
  expired: 'abgelaufen',
};

function AskDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const m = useSend('POST', '/me/questions');
  return (
    <Dialog
      title={t('Frage an die Leitung')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!subject.trim() || !body.trim() || m.isPending}
            onClick={() => m.mutate({ subject, body }, { onSuccess: onDone })}
          >
            {t('Senden')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Betreff')} htmlFor="q-subject">
        <input
          id="q-subject"
          className="input"
          maxLength={200}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </Field>
      <Field label={t('Deine Frage')} htmlFor="q-body">
        <textarea
          id="q-body"
          className="input"
          rows={4}
          maxLength={3000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </Field>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}
