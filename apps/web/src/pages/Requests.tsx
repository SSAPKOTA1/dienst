import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fromZonedTime } from 'date-fns-tz';
import { useGet, useSend } from '../lib/api';
import { fdate, fnum, ftime } from '../lib/format';
import { Dialog, ErrorNote, Field, PageHead, useToast } from '../components/ui';
import { ClaimSection, QuestionSection, SwapSection } from './RequestsMore';

const TZ = 'Europe/Berlin';

const FLAG_LABEL: Record<string, string> = {
  variation: 'Abweichung',
  unplanned: 'Ungeplant',
  auto_checkout: 'Auto-Ausstempeln',
  under_break: 'Pause zu kurz',
  correction: 'Korrektur',
};

const CORRECTION_LABEL: Record<string, string> = {
  missed_in: 'Einstempeln vergessen',
  missed_out: 'Ausstempeln vergessen',
  wrong_time: 'Falsche Zeit',
  missing_day: 'Fehlender Tag',
};

/** Never colour alone: every flag carries its text. */
export const FlagChip = ({ flag }: { flag: string }) => {
  const { t } = useTranslation();
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: '1px 6px',
        border: '1.5px solid var(--color-text)',
        background:
          flag === 'under_break' || flag === 'auto_checkout'
            ? 'var(--color-warning-100, #fff2cc)'
            : 'transparent',
        whiteSpace: 'nowrap',
      }}
    >
      {t(FLAG_LABEL[flag] ?? flag)}
    </span>
  );
};

const rowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0,1fr) auto',
  gap: 'var(--space-3)',
  alignItems: 'center',
  padding: 'var(--space-2) var(--space-4)',
  borderBottom: '1px solid var(--color-divider)',
};

const dayIso = (iso: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(iso));

function AdjustDialog({ item, onClose }: { item: any; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const base = item.paidStart ?? item.actualIn;
  const [start, setStart] = useState(ftime(base, TZ));
  const [end, setEnd] = useState(ftime(item.paidEnd ?? item.actualOut, TZ));
  const [brk, setBrk] = useState(String(item.breakMinutes ?? item.requiredBreakMinutes ?? 0));
  const [notes, setNotes] = useState('');
  const send = useSend('PUT', `/approvals/worked-time/${item.id}`);
  // the end belongs to the same local day, or the next one for night shifts
  const toIso = (hm: string, afterIso?: string) => {
    let d = fromZonedTime(`${dayIso(base)}T${hm}:00`, TZ);
    if (afterIso && d <= new Date(afterIso)) d = new Date(d.getTime() + 86400000);
    return d.toISOString();
  };
  const submit = () => {
    const paidStart = toIso(start);
    send.mutate(
      {
        decision: 'approve',
        paidStart,
        paidEnd: toIso(end, paidStart),
        breakMinutes: Number(brk),
        notes: notes || undefined,
      } as any,
      {
        onSuccess: () => {
          toast(t('Freigegeben'));
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      title={t('Bezahlte Zeit anpassen')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-primary" onClick={submit} disabled={send.isPending}>
            {t('Freigeben')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 13 }}>
        {item.displayName} · {fdate(item.shiftDate)} · {t('Gestempelt')} {ftime(item.actualIn, TZ)}–
        {ftime(item.actualOut, TZ)}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-2)' }}>
        <Field label={t('Bezahlt von')} htmlFor="adj-start">
          <input id="adj-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label={t('Bezahlt bis')} htmlFor="adj-end">
          <input id="adj-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field label={t('Pause (Min.)')} htmlFor="adj-brk">
          <input
            id="adj-brk"
            type="number"
            min={0}
            max={600}
            value={brk}
            onChange={(e) => setBrk(e.target.value)}
          />
        </Field>
      </div>
      <Field label={t('Notiz')} htmlFor="adj-notes">
        <input id="adj-notes" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <ErrorNote error={send.error} />
    </Dialog>
  );
}

function RejectDialog({
  title,
  onSubmit,
  onClose,
  error,
}: {
  title: string;
  onSubmit: (note: string) => void;
  onClose: () => void;
  error: unknown;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  return (
    <Dialog
      title={title}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-primary" onClick={() => onSubmit(note)}>
            {t('Ablehnen')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Notiz an die Mitarbeitenden (optional)')} htmlFor="rej-note">
        <input id="rej-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <ErrorNote error={error} />
    </Dialog>
  );
}

export function Requests() {
  const { t } = useTranslation();
  const toast = useToast();
  const hotels = useGet('/hotels');
  const [hotelId, setHotelId] = useState('');
  const q = { hotelId: hotelId || undefined, status: 'pending' };
  const worked = useGet('/approvals', { ...q, type: 'worked_time' });
  const absences = useGet('/approvals', { ...q, type: 'absence' });
  const corrections = useGet('/approvals', { ...q, type: 'correction' });
  const [sel, setSel] = useState<number[]>([]);
  const [adjust, setAdjust] = useState<any | null>(null);
  const [reject, setReject] = useState<{ kind: 'worked' | 'absence' | 'correction'; item: any } | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const decideWorked = useSend<any>('PUT', (b) => `/approvals/worked-time/${b.id}`);
  const decideAbsence = useSend<any>('PUT', (b) => `/approvals/absences/${b.id}`);
  const decideCorr = useSend<any>('PUT', (b) => `/approvals/corrections/${b.id}`);
  const bulk = useSend<{ ids: number[] }, any>('POST', '/approvals/worked-time/bulk-approve');

  const items = worked.data?.items ?? [];
  const selectable = items.filter((i: any) => i.flags.length === 0);
  const toggle = (id: number) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const ok = (msg: string) => () => {
    setErr(null);
    setSel([]);
    toast(msg);
  };
  const fail = (e: unknown) => setErr(e);

  const doBulk = () =>
    bulk.mutate(
      { ids: sel },
      {
        onSuccess: (r) => {
          setSel([]);
          toast(
            `${r.approved.length} ${t('freigegeben')}${r.failed.length ? `, ${r.failed.length} ${t('übersprungen')}` : ''}`,
          );
        },
        onError: fail,
      },
    );

  return (
    <main style={{ flex: 1, minWidth: 0 }}>
      <PageHead kicker={t('Heute')} title={t('Anträge')}>
        <select
          aria-label={t('Hotel')}
          value={hotelId}
          onChange={(e) => setHotelId(e.target.value)}
          style={{ minWidth: 180 }}
        >
          <option value="">{t('Alle Hotels')}</option>
          {(hotels.data?.items ?? []).map((h: any) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </PageHead>
      <ErrorNote error={err} />

      <section data-testid="req-worked" aria-labelledby="req-worked-h">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            padding: '0 var(--space-4)',
            borderTop: '2px solid var(--color-divider)',
            background: 'var(--color-surface)',
          }}
        >
          <h2
            id="req-worked-h"
            style={{
              margin: 0,
              fontSize: 14,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              padding: 'var(--space-3) 0',
              marginRight: 'auto',
            }}
          >
            {t('Zeiten prüfen')} <span style={{ fontVariantNumeric: 'tabular-nums' }}>({items.length})</span>
          </h2>
          <button
            className="btn btn-secondary"
            disabled={!selectable.length}
            onClick={() => setSel(sel.length === selectable.length ? [] : selectable.map((i: any) => i.id))}
          >
            {sel.length === selectable.length && sel.length
              ? t('Auswahl aufheben')
              : t('Unauffällige auswählen')}
          </button>
          <button
            className="btn btn-primary"
            disabled={!sel.length || bulk.isPending}
            onClick={doBulk}
            data-testid="bulk-approve"
          >
            {t('Ausgewählte freigeben')} ({sel.length})
          </button>
        </div>
        {items.length === 0 && (
          <div style={{ padding: 'var(--space-3) var(--space-4)', fontSize: 13 }}>
            {t('Nichts zu prüfen.')}
          </div>
        )}
        {items.map((i: any) => (
          <div key={i.id} style={rowStyle} data-testid="worked-row">
            <input
              type="checkbox"
              aria-label={`${t('Auswählen')}: ${i.displayName}`}
              checked={sel.includes(i.id)}
              disabled={i.flags.length > 0}
              onChange={() => toggle(i.id)}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              <div
                style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}
              >
                <b style={{ fontSize: 15 }}>{i.displayName}</b>
                <span style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
                  {fdate(i.shiftDate, { weekday: 'short', day: '2-digit', month: '2-digit' })}
                </span>
                {i.overdue && (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 800,
                      padding: '1px 6px',
                      background: 'var(--color-text)',
                      color: 'var(--color-bg)',
                    }}
                  >
                    {i.ageDays} {t('Tage offen')}
                  </span>
                )}
                {i.flags.map((f: string) => (
                  <FlagChip key={f} flag={f} />
                ))}
              </div>
              <div
                style={{
                  fontSize: 12,
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--color-neutral-800)',
                }}
              >
                {t('Geplant')}{' '}
                {i.plannedStart ? `${ftime(i.plannedStart, TZ)}–${ftime(i.plannedEnd, TZ)}` : '–'} ·{' '}
                {t('Gestempelt')} {ftime(i.actualIn, TZ)}–{ftime(i.actualOut, TZ)} · {t('Pause')}{' '}
                {i.breakMinutes ?? 0} {t('Min.')} · <b>{fnum(i.paidHours, 2)} h</b>
              </div>
              {i.variations
                .filter((v: any) => v.reason)
                .map((v: any, k: number) => (
                  <div key={k} style={{ fontSize: 12 }}>
                    „{v.reason}“
                  </div>
                ))}
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
              <button
                className="btn btn-primary"
                onClick={() =>
                  decideWorked.mutate(
                    { id: i.id, decision: 'approve' },
                    { onSuccess: ok(t('Freigegeben')), onError: fail },
                  )
                }
              >
                {t('Freigeben')}
              </button>
              <button className="btn btn-secondary" onClick={() => setAdjust(i)}>
                {t('Anpassen')}
              </button>
              <button className="btn btn-secondary" onClick={() => setReject({ kind: 'worked', item: i })}>
                {t('Ablehnen')}
              </button>
            </div>
          </div>
        ))}
      </section>

      <section data-testid="req-absence" aria-labelledby="req-abs-h" style={{ marginTop: 'var(--space-4)' }}>
        <div
          style={{
            padding: '0 var(--space-4)',
            borderTop: '2px solid var(--color-divider)',
            background: 'var(--color-surface)',
          }}
        >
          <h2
            id="req-abs-h"
            style={{
              margin: 0,
              fontSize: 14,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              padding: 'var(--space-3) 0',
            }}
          >
            {t('Abwesenheiten')} ({absences.data?.items?.length ?? 0})
          </h2>
        </div>
        {(absences.data?.items ?? []).length === 0 && (
          <div style={{ padding: 'var(--space-3) var(--space-4)', fontSize: 13 }}>
            {t('Keine offenen Anträge.')}
          </div>
        )}
        {(absences.data?.items ?? []).map((a: any) => (
          <div
            key={a.id}
            style={{ ...rowStyle, gridTemplateColumns: 'minmax(0,1fr) auto' }}
            data-testid="absence-row"
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div
                style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}
              >
                <b style={{ fontSize: 15 }}>{a.displayName}</b>
                <span style={{ fontSize: 13 }}>
                  {t('Urlaub')} {fdate(a.from)}–{fdate(a.to)} · {a.days} {t('Tage')}
                </span>
              </div>
              <div style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                {t('Rest')} {fnum(a.remaining)} → <b>{fnum(a.remainingAfter)}</b>
              </div>
              {a.reason && <div style={{ fontSize: 12 }}>„{a.reason}“</div>}
              {a.understaffing.length > 0 && (
                <div style={{ fontSize: 12, fontWeight: 700 }} role="note">
                  ⚠ {t('Unterbesetzung')}:{' '}
                  {a.understaffing
                    .map(
                      (u: any) =>
                        `${fdate(u.date, { day: '2-digit', month: '2-digit' })} ${u.departmentName} ${u.assigned}/${u.required}`,
                    )
                    .join(', ')}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
              <button
                className="btn btn-primary"
                onClick={() =>
                  decideAbsence.mutate(
                    { id: a.id, decision: 'approve' },
                    { onSuccess: ok(t('Freigegeben')), onError: fail },
                  )
                }
              >
                {t('Freigeben')}
              </button>
              <button className="btn btn-secondary" onClick={() => setReject({ kind: 'absence', item: a })}>
                {t('Ablehnen')}
              </button>
            </div>
          </div>
        ))}
      </section>

      <section
        data-testid="req-correction"
        aria-labelledby="req-cor-h"
        style={{ margin: 'var(--space-4) 0' }}
      >
        <div
          style={{
            padding: '0 var(--space-4)',
            borderTop: '2px solid var(--color-divider)',
            background: 'var(--color-surface)',
          }}
        >
          <h2
            id="req-cor-h"
            style={{
              margin: 0,
              fontSize: 14,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              padding: 'var(--space-3) 0',
            }}
          >
            {t('Stempelkorrekturen')} ({corrections.data?.items?.length ?? 0})
          </h2>
        </div>
        {(corrections.data?.items ?? []).length === 0 && (
          <div style={{ padding: 'var(--space-3) var(--space-4)', fontSize: 13 }}>
            {t('Keine offenen Anträge.')}
          </div>
        )}
        {(corrections.data?.items ?? []).map((c: any) => (
          <div
            key={c.id}
            style={{ ...rowStyle, gridTemplateColumns: 'minmax(0,1fr) auto' }}
            data-testid="correction-row"
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div
                style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}
              >
                <b style={{ fontSize: 15 }}>{c.displayName}</b>
                <span style={{ fontSize: 13 }}>
                  {t(CORRECTION_LABEL[c.correctionType] ?? c.correctionType)}
                </span>
                <FlagChip flag="correction" />
              </div>
              <div style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                {c.requestedIn ? `${fdate(dayIso(c.requestedIn))} ${ftime(c.requestedIn, TZ)}` : '–'} –{' '}
                {c.requestedOut ? ftime(c.requestedOut, TZ) : '–'}
              </div>
              <div style={{ fontSize: 12 }}>„{c.reason}“</div>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
              <button
                className="btn btn-primary"
                onClick={() =>
                  decideCorr.mutate(
                    { id: c.id, decision: 'approve' },
                    { onSuccess: ok(t('Freigegeben')), onError: fail },
                  )
                }
              >
                {t('Freigeben')}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setReject({ kind: 'correction', item: c })}
              >
                {t('Ablehnen')}
              </button>
            </div>
          </div>
        ))}
      </section>

      <SwapSection hotelId={hotelId} />
      <ClaimSection hotelId={hotelId} />
      <QuestionSection hotelId={hotelId} />

      {adjust && <AdjustDialog item={adjust} onClose={() => setAdjust(null)} />}
      {reject && (
        <RejectDialog
          title={t('Ablehnen')}
          error={decideWorked.error ?? decideAbsence.error ?? decideCorr.error}
          onClose={() => setReject(null)}
          onSubmit={(note) => {
            const done = {
              onSuccess: () => {
                setReject(null);
                ok(t('Abgelehnt'))();
              },
            };
            if (reject.kind === 'worked')
              decideWorked.mutate({ id: reject.item.id, decision: 'reject', notes: note || undefined }, done);
            else if (reject.kind === 'absence')
              decideAbsence.mutate({ id: reject.item.id, decision: 'reject', note: note || undefined }, done);
            else
              decideCorr.mutate({ id: reject.item.id, decision: 'reject', notes: note || undefined }, done);
          }}
        />
      )}
    </main>
  );
}
