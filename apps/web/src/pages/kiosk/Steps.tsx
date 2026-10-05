import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { enqueue, type OfflineRosterItem } from '../../lib/offlineKiosk';
import { Item, KioskError, PunchAction, Step, hm, kapi } from './common';

export const doneBtn: React.CSSProperties = {
  marginTop: 'auto',
  alignSelf: 'flex-start',
  fontSize: 20,
  fontWeight: 700,
  border: '2px solid var(--color-bg)',
  background: 'transparent',
  color: 'var(--color-bg)',
  padding: '14px 28px',
  cursor: 'pointer',
};

export function Register({ onSave, invalid }: { onSave: (t: string) => void; invalid: boolean }) {
  const { t } = useTranslation();
  const [v, setV] = useState('');
  return (
    <main style={{ padding: 'var(--space-8)', maxWidth: 640 }}>
      <h1>{t('Gerät nicht registriert')}</h1>
      <p>
        {invalid
          ? t(
              'Dieses Tablet ist nicht (mehr) registriert. Bitte die Administration um ein neues Gerätetoken.',
            )
          : t('Gib das Gerätetoken ein, das die Administration unter „Tablets“ angelegt hat.')}
      </p>
      <div className="field">
        <label htmlFor="kt">{t('Gerätetoken')}</label>
        <input id="kt" className="input" value={v} onChange={(e) => setV(e.target.value)} />
      </div>
      <button
        className="btn btn-primary"
        style={{ marginTop: 'var(--space-3)' }}
        disabled={!v}
        onClick={() => onSave(v.trim())}
      >
        {t('Speichern')}
      </button>
    </main>
  );
}

const ACTION_LABEL: Record<PunchAction, string> = {
  in: 'Einstempeln',
  out: 'Ausstempeln',
  break_start: 'Pause starten',
  break_end: 'Pause beenden',
};

export function ActionStep({
  item,
  online,
  breakMode,
  onBack,
  onPick,
}: {
  item: Item;
  online: boolean;
  breakMode: 'confirm_at_clock_out' | 'start_stop';
  onBack: () => void;
  onPick: (a: PunchAction) => void;
}) {
  const { t } = useTranslation();
  const actions: PunchAction[] = !online
    ? breakMode === 'start_stop'
      ? ['in', 'out', 'break_start', 'break_end']
      : ['in', 'out']
    : item.state === 'on_break'
      ? ['break_end', 'out']
      : ['break_start', 'out'];
  return (
    <div
      style={{
        padding: 'var(--space-6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
        flex: 1,
      }}
    >
      <button className="btn btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 16 }} onClick={onBack}>
        ← {t('Nicht du?')}
      </button>
      <h1 style={{ margin: 0, fontSize: 48, lineHeight: 1.05 }}>{item.displayName}</h1>
      <div
        role="group"
        aria-label={t('Was möchtest du tun?')}
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))',
          gap: 2,
          background: 'var(--color-divider)',
          border: '2px solid var(--color-divider)',
        }}
      >
        {actions.map((a) => (
          <button
            key={a}
            data-testid={`action-${a}`}
            onClick={() => onPick(a)}
            style={{
              minHeight: 120,
              fontSize: 28,
              fontWeight: 800,
              border: 0,
              cursor: 'pointer',
              background: 'var(--color-bg)',
              textAlign: 'left',
              padding: '0 var(--space-6)',
            }}
          >
            {t(ACTION_LABEL[a])}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SavedDone({
  step,
  tz,
  onDone,
}: {
  step: Extract<Step, { kind: 'saved' }>;
  tz: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const label =
    step.action === 'break_start'
      ? 'Pause gestartet'
      : step.action === 'break_end'
        ? 'Pause beendet'
        : step.action === 'in'
          ? 'Eingestempelt'
          : 'Ausgestempelt';
  return (
    <div
      style={{
        flex: 1,
        background: 'var(--color-accent)',
        color: 'var(--color-bg)',
        padding: 'var(--space-8)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
      role="status"
      data-testid="kiosk-done"
    >
      <h1 style={{ margin: 0, fontSize: 56, lineHeight: 1 }}>
        {t(label)} {hm(step.at, tz)}
      </h1>
      <div style={{ fontSize: 22 }}>{step.item.displayName}</div>
      {step.offline && (
        <div
          style={{ fontSize: 18, borderTop: '2px solid var(--color-bg)', paddingTop: 'var(--space-3)' }}
          data-testid="kiosk-saved-offline"
        >
          {t('Offline gespeichert. Deine Leitung prüft die Zeit.')}
        </div>
      )}
      <button onClick={onDone} style={doneBtn} data-testid="kiosk-finish">
        {t('Fertig')}
      </button>
    </div>
  );
}

export function PinStep({
  item,
  action,
  online,
  cache,
  pinLength,
  sub,
  onBack,
  onDone,
  nowIso,
  tz,
}: {
  item: Item;
  action: PunchAction;
  online: boolean;
  cache: OfflineRosterItem[];
  pinLength: number;
  sub: string;
  onBack: () => void;
  onDone: (s: Step) => void;
  nowIso: () => string;
  tz: string;
}) {
  const { t } = useTranslation();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  void tz;
  const submit = async (value: string) => {
    setBusy(true);
    setError(null);
    // without a connection the punch waits on the tablet; the server checks the PIN when it is sent
    const queue = async () => {
      const offlineRef = item.offlineRef ?? cache.find((c) => c.displayName === item.displayName)?.offlineRef;
      if (!offlineRef) throw new KioskError(0, 'NETWORK', {}, 'No connection');
      const off = { ...item, offlineRef };
      if (action === 'out') return onDone({ kind: 'offbreak', item: off, pin: value });
      await enqueue({ action, offlineRef, displayName: item.displayName, pin: value, occurredAt: nowIso() });
      onDone({ kind: 'saved', item: off, action, at: nowIso(), offline: true });
    };
    try {
      if (!online) return await queue();
      const body = { employeeRef: item.employeeRef, pin: value };
      if (action === 'out') {
        const out = await kapi('/kiosk/punch-out', { body });
        onDone({ kind: 'break', item, out });
      } else if (action === 'in') {
        const res = await kapi('/kiosk/punch-in', { body });
        onDone({ kind: 'in', item, res });
      } else {
        await kapi(action === 'break_start' ? '/kiosk/break-start' : '/kiosk/break-end', { body });
        onDone({ kind: 'saved', item, action, at: nowIso(), offline: false });
      }
    } catch (e) {
      const err = e as KioskError;
      setPin('');
      if (err.code === 'NETWORK') {
        try {
          return await queue();
        } catch {
          setError(t('Keine Verbindung.'));
        }
      } else if (err.code === 'PIN_INVALID')
        setError(
          err.details.remainingAttempts === 1
            ? t('Falsche PIN. Noch 1 Versuch.')
            : t('Falsche PIN. Noch {{n}} Versuche.', { n: err.details.remainingAttempts }),
        );
      else if (err.code === 'PIN_LOCKED') setError(t('PIN gesperrt. Bitte wende dich an deine Leitung.'));
      else if (err.code === 'ALREADY_CLOCKED_IN') setError(t('Du bist bereits eingestempelt.'));
      else if (err.code === 'NOT_FOUND') setError(t('Kein offener Eintrag gefunden.'));
      else if (err.code === 'CONFLICT')
        setError(t('Das passt gerade nicht: Pause läuft bereits oder ist nicht gestartet.'));
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const press = (k: string) => {
    if (busy) return;
    if (k === 'del') return setPin((p) => p.slice(0, -1));
    if (k === 'clr') return setPin('');
    const next = (pin + k).slice(0, pinLength);
    setPin(next);
    if (next.length === pinLength) void submit(next);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      if (e.key === 'Backspace') press('del');
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clr', '0', 'del'];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', flex: 1 }}>
      <div
        style={{
          padding: 'var(--space-6)',
          borderRight: '2px solid var(--color-divider)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        <button className="btn btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 16 }} onClick={onBack}>
          ← {t('Nicht du?')}
        </button>
        <h1 style={{ margin: 0, fontSize: 48, lineHeight: 1.05 }}>{item.displayName}</h1>
        <div style={{ fontSize: 18 }}>
          {t(ACTION_LABEL[action])} · {sub}
        </div>
        <div style={{ marginTop: 'auto', fontSize: 20, fontWeight: 600 }}>
          {t('Gib deine {{n}}-stellige PIN ein', { n: pinLength })}
        </div>
        <div
          style={{ display: 'flex', gap: 'var(--space-3)' }}
          role="img"
          aria-label={`${pin.length}/${pinLength}`}
        >
          {Array.from({ length: pinLength }).map((_, i) =>
            i < pin.length ? (
              <span key={i} style={{ width: 28, height: 28, background: 'var(--color-text)' }} />
            ) : (
              <span key={i} style={{ width: 24, height: 24, border: '2px solid var(--color-text)' }} />
            ),
          )}
        </div>
        {error && (
          <div
            role="alert"
            data-testid="kiosk-error"
            style={{ fontSize: 16, color: 'var(--warn)', fontWeight: 700 }}
          >
            {error}
          </div>
        )}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3,1fr)',
          gap: 2,
          background: 'var(--color-divider)',
        }}
      >
        {keys.map((k) => (
          <button
            key={k}
            data-testid={`key-${k}`}
            onClick={() => press(k)}
            style={{
              fontSize: k.length > 1 ? 18 : 32,
              fontWeight: 700,
              border: 0,
              background: 'var(--color-bg)',
              cursor: 'pointer',
              minHeight: 96,
              textAlign: 'left',
              padding: '0 var(--space-6)',
            }}
          >
            {k === 'clr' ? t('Löschen') : k === 'del' ? '←' : k}
          </button>
        ))}
      </div>
    </div>
  );
}

export function InDone({
  step,
  tz,
  onDone,
}: {
  step: Extract<Step, { kind: 'in' }>;
  tz: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [sent, setSent] = useState(false);
  const { res } = step;
  const send = async () => {
    await kapi('/kiosk/punch/reason', { body: { confirmToken: res.confirmToken, reason } }).catch(
      () => undefined,
    );
    setSent(true);
  };
  return (
    <div
      style={{
        flex: 1,
        background: 'var(--color-accent)',
        color: 'var(--color-bg)',
        padding: 'var(--space-8)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
      role="status"
      data-testid="kiosk-done"
    >
      <svg
        width="64"
        height="64"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        aria-hidden
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
      <h1 style={{ margin: 0, fontSize: 56, lineHeight: 1 }}>
        {t('Eingestempelt')} {hm(res.clockedInAt, tz)}
      </h1>
      <div style={{ fontSize: 22 }}>{step.item.displayName}</div>
      {res.isUnplanned && (
        <div style={{ fontSize: 18, borderTop: '2px solid var(--color-bg)', paddingTop: 'var(--space-3)' }}>
          {t('Ungeplanter Einsatz. Deine Leitung prüft die Zeit.')}
        </div>
      )}
      {!res.isUnplanned && !res.variation.withinGrace && (
        <div style={{ fontSize: 18, borderTop: '2px solid var(--color-bg)', paddingTop: 'var(--space-3)' }}>
          {t('Deine Leitung sieht das')}: {res.variation.minutes > 0 ? '+' : ''}
          {res.variation.minutes} {t('Min.')}
        </div>
      )}
      {res.reasonRequired && !sent && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'stretch' }}>
          <input
            className="input"
            style={{ fontSize: 18 }}
            placeholder={t('Grund (optional)')}
            aria-label={t('Grund (optional)')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            className="btn btn-secondary"
            style={{ background: 'var(--color-bg)' }}
            disabled={!reason.trim()}
            onClick={() => void send()}
          >
            {t('Senden')}
          </button>
        </div>
      )}
      {sent && <div>{t('Gespeichert.')}</div>}
      <button onClick={onDone} style={doneBtn} data-testid="kiosk-finish">
        {t('Fertig')}
      </button>
    </div>
  );
}

export function BreakStep({
  step,
  onDone,
  onBack,
  offlineSubmit,
}: {
  step: Extract<Step, { kind: 'break' }>;
  onDone: (r: any) => void;
  onBack: () => void;
  offlineSubmit?: (brk: number, reason?: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { out } = step;
  const [brk, setBrk] = useState(out.suggestedBreakMinutes);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const short = brk < out.requiredBreakMinutes;
  const submit = async () => {
    setError(null);
    try {
      if (offlineSubmit) return await offlineSubmit(brk, reason.trim() || undefined);
      onDone(
        await kapi('/kiosk/punch-out/confirm-break', {
          body: {
            confirmToken: out.confirmToken,
            actualBreakMinutes: brk,
            reason: reason.trim() || undefined,
          },
        }),
      );
    } catch (e) {
      const err = e as KioskError;
      setError(
        err.code === 'REASON_REQUIRED'
          ? t('Bitte gib einen Grund an, warum die Pause kürzer war.')
          : err.message,
      );
    }
  };
  return (
    <div
      style={{
        padding: 'var(--space-6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
        flex: 1,
      }}
    >
      <button className="btn btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 16 }} onClick={onBack}>
        ← {t('Abbrechen')}
      </button>
      <h1 style={{ margin: 0, fontSize: 40 }}>
        {step.item.displayName}: {t('Pause bestätigen')}
      </h1>
      {out.grossMinutes > 0 && (
        <div style={{ fontSize: 18 }}>
          {t('Gearbeitet')}: {Math.floor(out.grossMinutes / 60)}:
          {String(out.grossMinutes % 60).padStart(2, '0')} {t('Std.')} · {t('Vorgeschrieben')}:{' '}
          {out.requiredBreakMinutes} {t('Min.')}
          {out.recordedBreakMinutes != null && (
            <>
              {' '}
              · {t('Aufgezeichnet')}: {out.recordedBreakMinutes} {t('Min.')}
            </>
          )}
        </div>
      )}
      <div
        role="radiogroup"
        aria-label={t('Pause')}
        style={{
          display: 'flex',
          gap: 2,
          background: 'var(--color-divider)',
          border: '2px solid var(--color-divider)',
          flexWrap: 'wrap',
        }}
      >
        {out.options.map((o) => (
          <button
            key={o}
            role="radio"
            aria-checked={brk === o}
            data-testid={`break-${o}`}
            onClick={() => setBrk(o)}
            style={{
              flex: 1,
              minWidth: 110,
              minHeight: 96,
              fontSize: 28,
              fontWeight: 800,
              border: 0,
              cursor: 'pointer',
              background: brk === o ? 'var(--color-text)' : 'var(--color-bg)',
              color: brk === o ? 'var(--color-bg)' : 'var(--color-text)',
            }}
          >
            {o} {t('Min.')}
          </button>
        ))}
      </div>
      {short && (
        <div className="field">
          <label htmlFor="br">{t('Grund (Pflicht, Pause kürzer als vorgeschrieben)')}</label>
          <textarea
            id="br"
            className="input"
            style={{ fontSize: 18 }}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            data-testid="break-reason"
          />
        </div>
      )}
      {error && (
        <div role="alert" style={{ color: 'var(--warn)', fontWeight: 700 }}>
          {error}
        </div>
      )}
      <button
        className="btn btn-primary"
        style={{ justifyContent: 'center', fontSize: 30, fontWeight: 800, minHeight: 110, marginTop: 'auto' }}
        disabled={short && !reason.trim()}
        onClick={() => void submit()}
        data-testid="break-ok"
      >
        OK
      </button>
    </div>
  );
}
