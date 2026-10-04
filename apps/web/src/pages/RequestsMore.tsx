import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../lib/api';
import { fdate, fdatetime, ftime } from '../lib/format';
import { Dialog, ErrorNote, Field, useToast } from '../components/ui';

const TZ = 'Europe/Berlin';
const head: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  padding: 'var(--space-3) 0',
};
const bar: React.CSSProperties = {
  padding: '0 var(--space-4)',
  borderTop: '2px solid var(--color-divider)',
  background: 'var(--color-surface)',
};
const row: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0,1fr) auto',
  gap: 'var(--space-3)',
  alignItems: 'center',
  padding: 'var(--space-2) var(--space-4)',
  borderBottom: '1px solid var(--color-divider)',
};
const slot = (s: any) =>
  s
    ? `${fdate(s.date, { weekday: 'short', day: '2-digit', month: '2-digit' })} ${ftime(s.start, TZ)}–${ftime(s.end, TZ)}${s.shiftName ? ` ${s.shiftName}` : ''}`
    : '';

/** Swap requests that the colleague has accepted and that wait for a planner. */
export function SwapSection({ hotelId }: { hotelId?: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const list = useGet('/approvals/swaps', { hotelIds: hotelId || undefined, status: 'accepted_by_peer' });
  const decide = useSend<any>('PUT', (b) => `/approvals/swaps/${b.id}`);
  const [reason, setReason] = useState<{ id: number; violations: any[] } | null>(null);
  const [text, setText] = useState('');
  const items = list.data?.items ?? [];
  const run = (id: number, body: any) =>
    decide.mutate(
      { id, ...body },
      {
        onSuccess: () => {
          setReason(null);
          toast(t('Entschieden'));
          void list.refetch();
        },
        onError: (e: any) => {
          if (e.code === 'REASON_REQUIRED') setReason({ id, violations: e.details?.violations ?? [] });
        },
      },
    );
  return (
    <section data-testid="req-swaps" aria-labelledby="req-swap-h" style={{ marginTop: 'var(--space-4)' }}>
      <div style={bar}>
        <h2 id="req-swap-h" style={head}>
          {t('Schichttausch')} ({items.length})
        </h2>
      </div>
      {items.length === 0 && (
        <div style={{ padding: 'var(--space-3) var(--space-4)', fontSize: 13 }}>
          {t('Keine offenen Anträge.')}
        </div>
      )}
      {items.map((s: any) => (
        <div key={s.id} style={row} data-testid="swap-req">
          <div>
            <b>{s.requester}</b> → <b>{s.counterpart}</b>
            <div style={{ fontSize: 13 }}>
              {slot(s.slot)}
              {s.counterpartSlot ? ` ⇄ ${slot(s.counterpartSlot)}` : ''}
            </div>
            {s.reason && <div style={{ fontSize: 12 }}>„{s.reason}“</div>}
            {s.violations
              .filter((v: any) => v.severity !== 'warn')
              .map((v: any, i: number) => (
                <div key={i} style={{ fontSize: 12, fontWeight: 700 }}>
                  ⚠ {v.code}
                </div>
              ))}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="btn btn-primary" onClick={() => run(s.id, { decision: 'approve' })}>
              {t('Freigeben')}
            </button>
            <button className="btn btn-secondary" onClick={() => run(s.id, { decision: 'reject' })}>
              {t('Ablehnen')}
            </button>
          </div>
        </div>
      ))}
      {reason && (
        <Dialog
          title={t('Begründung nötig')}
          onClose={() => setReason(null)}
          actions={
            <>
              <button
                className="btn btn-primary"
                disabled={text.trim().length < 5}
                onClick={() => run(reason.id, { decision: 'approve', overrideReason: text })}
              >
                {t('Trotzdem freigeben')}
              </button>
              <button className="btn btn-secondary" onClick={() => setReason(null)}>
                {t('Abbrechen')}
              </button>
            </>
          }
        >
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {reason.violations.map((v, i) => (
              <li key={i}>{v.code}</li>
            ))}
          </ul>
          <Field label={t('Begründung (wird protokolliert)')} htmlFor="sw-reason2">
            <input
              id="sw-reason2"
              className="input"
              value={text}
              maxLength={300}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
        </Dialog>
      )}
      <ErrorNote
        error={decide.error && (decide.error as any).code !== 'REASON_REQUIRED' ? decide.error : null}
      />
    </section>
  );
}

/** Applications for open shifts. */
export function ClaimSection({ hotelId }: { hotelId?: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const list = useGet('/open-shifts', { hotelIds: hotelId || undefined, status: 'open' });
  const decide = useSend<any>('PUT', (b) => `/open-shifts/claims/${b.id}`);
  const items = (list.data?.items ?? []).filter((o: any) =>
    o.claims.some((c: any) => c.status === 'pending'),
  );
  return (
    <section data-testid="req-claims" aria-labelledby="req-claim-h" style={{ marginTop: 'var(--space-4)' }}>
      <div style={bar}>
        <h2 id="req-claim-h" style={head}>
          {t('Bewerbungen auf offene Schichten')} ({items.length})
        </h2>
      </div>
      {items.length === 0 && (
        <div style={{ padding: 'var(--space-3) var(--space-4)', fontSize: 13 }}>
          {t('Keine Bewerbungen.')}
        </div>
      )}
      {items.map((o: any) => (
        <div
          key={o.id}
          style={{ padding: 'var(--space-2) var(--space-4)', borderBottom: '1px solid var(--color-divider)' }}
        >
          <b>
            {fdate(o.date, { weekday: 'short', day: '2-digit', month: '2-digit' })} {ftime(o.start, TZ)}–
            {ftime(o.end, TZ)}
          </b>
          {o.claims
            .filter((c: any) => c.status === 'pending')
            .map((c: any) => (
              <div
                key={c.id}
                style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}
                data-testid="claim-row"
              >
                <span style={{ marginRight: 'auto' }}>{c.displayName}</span>
                <button
                  className="btn btn-primary"
                  onClick={() =>
                    decide.mutate(
                      { id: c.id, decision: 'approve' },
                      {
                        onSuccess: () => {
                          toast(t('Eingeplant'));
                          void list.refetch();
                        },
                      },
                    )
                  }
                >
                  {t('Einplanen')}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() =>
                    decide.mutate({ id: c.id, decision: 'reject' }, { onSuccess: () => void list.refetch() })
                  }
                >
                  {t('Ablehnen')}
                </button>
              </div>
            ))}
        </div>
      ))}
      <ErrorNote error={decide.error} />
    </section>
  );
}

/** Questions of employees to management. */
export function QuestionSection({ hotelId }: { hotelId?: string }) {
  const { t } = useTranslation();
  const list = useGet('/questions', { hotelIds: hotelId || undefined, status: 'open' });
  const [q, setQ] = useState<any | null>(null);
  const items = list.data?.items ?? [];
  return (
    <section data-testid="req-questions" aria-labelledby="req-q-h" style={{ margin: 'var(--space-4) 0' }}>
      <div style={bar}>
        <h2 id="req-q-h" style={head}>
          {t('Fragen an die Leitung')} ({items.length})
        </h2>
      </div>
      {items.length === 0 && (
        <div style={{ padding: 'var(--space-3) var(--space-4)', fontSize: 13 }}>
          {t('Keine offenen Fragen.')}
        </div>
      )}
      {items.map((x: any) => (
        <div key={x.id} style={row} data-testid="question-req">
          <div>
            <b>{x.displayName}</b> · {x.subject}
            <div style={{ fontSize: 13 }}>{x.body}</div>
            <div style={{ fontSize: 11 }}>{fdatetime(x.createdAt)}</div>
          </div>
          <button className="btn btn-primary" onClick={() => setQ(x)}>
            {t('Antworten')}
          </button>
        </div>
      ))}
      {q && (
        <AnswerDialog
          q={q}
          onClose={() => setQ(null)}
          onDone={() => {
            setQ(null);
            void list.refetch();
          }}
        />
      )}
    </section>
  );
}

function AnswerDialog({ q, onClose, onDone }: { q: any; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState('');
  const m = useSend<any>('PUT', `/questions/${q.id}/answer`);
  return (
    <Dialog
      title={q.subject}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!answer.trim() || m.isPending}
            onClick={() => m.mutate({ answer }, { onSuccess: onDone })}
          >
            {t('Antwort senden')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 13 }}>
        {q.displayName}: {q.body}
      </p>
      <Field label={t('Antwort')} htmlFor="ans">
        <textarea
          id="ans"
          className="input"
          rows={4}
          maxLength={3000}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
      </Field>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}
