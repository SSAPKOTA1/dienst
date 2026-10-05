import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildUrl } from '../lib/api';
import { fnum } from '../lib/format';
import { LangSwitch } from '../components/LangSwitch';
import {
  clearLocalStates,
  enqueue,
  flushQueue,
  loadOfflineRoster,
  localStates,
  queueLength,
  saveOfflineRoster,
  type OfflineAction,
  type OfflineRosterItem,
} from '../lib/offlineKiosk';

const KEY = 'kioskToken';
const IDLE_MS = 30_000;

interface Item {
  employeeRef: string;
  offlineRef?: string;
  displayName: string;
  departmentName: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  state: 'not_in' | 'working' | 'on_break' | 'done';
}
interface Roster {
  serverTime: string;
  timezone: string;
  hotelName: string;
  deviceName: string;
  pinLength: number;
  breakMode?: 'confirm_at_clock_out' | 'start_stop';
  identification?: 'name_pin' | 'badge_pin';
  items: Item[];
}

class KioskError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, any>,
    message: string,
  ) {
    super(message);
  }
}

const getToken = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

async function kapi<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  let r: Response;
  try {
    r = await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: {
        'x-kiosk-token': getToken() ?? '',
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new KioskError(0, 'NETWORK', {}, 'No connection');
  }
  const b = await r.json().catch(() => null);
  if (!r.ok)
    throw new KioskError(
      r.status,
      b?.error?.code ?? 'INTERNAL',
      b?.error?.details ?? {},
      b?.error?.message ?? r.statusText,
    );
  return b as T;
}

type PunchAction = OfflineAction;

type Step =
  | { kind: 'list' }
  | { kind: 'action'; item: Item }
  | { kind: 'pin'; item: Item; action: PunchAction }
  | { kind: 'offbreak'; item: Item; pin: string }
  | { kind: 'saved'; item: Item; action: PunchAction; at: string; offline: boolean }
  | {
      kind: 'break';
      item: Item;
      out: {
        confirmToken: string;
        grossMinutes: number;
        requiredBreakMinutes: number;
        suggestedBreakMinutes: number;
        recordedBreakMinutes?: number | null;
        options: number[];
      };
    }
  | {
      kind: 'in';
      item: Item;
      res: {
        clockedInAt: string;
        isUnplanned: boolean;
        reasonRequired: boolean;
        variation: { minutes: number; withinGrace: boolean };
        confirmToken: string;
      };
    }
  | {
      kind: 'out';
      item: Item;
      res: { status: string; paidHours: number; approvalStatus: string };
      at: string;
    };

const hm = (iso: string | null, tz: string) =>
  iso
    ? new Intl.DateTimeFormat('de-DE', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(iso))
    : '';

export function Kiosk() {
  const { t } = useTranslation();
  const [token, setToken] = useState<string | null>(getToken());
  const [roster, setRoster] = useState<Roster | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [step, setStep] = useState<Step>({ kind: 'list' });
  const [q, setQ] = useState('');
  const [found, setFound] = useState<
    Array<{ employeeRef: string; offlineRef?: string; displayName: string }>
  >([]);
  const [online, setOnline] = useState(true);
  const [queueN, setQueueN] = useState(queueLength());
  const [notice, setNotice] = useState<string | null>(null);
  const [cache, setCache] = useState<OfflineRosterItem[]>(loadOfflineRoster());
  const idle = useRef<number | undefined>(undefined);
  const pickRefRef = useRef<(ref: string, name: string) => unknown>(() => undefined);
  const tz = roster?.timezone ?? 'Europe/Berlin';
  const breakMode = roster?.breakMode ?? 'confirm_at_clock_out';

  const sync = useCallback(async () => {
    if (!queueLength()) return;
    try {
      const r = await flushQueue((items) => kapi('/kiosk/offline-sync', { body: { items } }));
      setQueueN(queueLength());
      if (r.rejected > 0)
        setNotice(
          t('{{n}} offline erfasste Stempelungen wurden abgelehnt. Die Leitung ist informiert.', {
            n: r.rejected,
          }),
        );
      else if (r.applied > 0) setNotice(t('Offline erfasste Stempelungen wurden übertragen.'));
    } catch {
      /* still offline: the queue stays */
    }
  }, [t]);

  const load = useCallback(async () => {
    try {
      const r = await kapi<Roster>('/kiosk/roster');
      setRoster(r);
      setOffset(new Date(r.serverTime).getTime() - Date.now());
      setInvalid(false);
      setOnline(true);
      if (queueLength()) void sync();
      else clearLocalStates();
    } catch (e) {
      const code = (e as KioskError).code;
      if (code === 'DEVICE_INVALID') setInvalid(true);
      if (code === 'NETWORK') setOnline(false);
    }
  }, [sync]);

  // the list of today's people is kept on the tablet so that punching still works without a connection
  const refreshCache = useCallback(async () => {
    try {
      const r = await kapi<{ items: OfflineRosterItem[] }>('/kiosk/offline-roster');
      saveOfflineRoster(r.items);
      setCache(r.items);
    } catch {
      /* keep the old copy */
    }
  }, []);
  useEffect(() => {
    if (!token) return;
    void refreshCache();
    const a = setInterval(() => void refreshCache(), 5 * 60_000);
    const goOffline = () => setOnline(false);
    const goOnline = () => void load();
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      clearInterval(a);
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, [token, refreshCache, load]);

  useEffect(() => {
    if (!token) return;
    void load();
    const a = setInterval(() => void load(), 20_000);
    const b = setInterval(() => void kapi('/kiosk/heartbeat', { body: {} }).catch(() => undefined), 60_000);
    const c = setInterval(() => setNow(Date.now()), 1000);
    void kapi('/kiosk/heartbeat', { body: {} }).catch(() => undefined);
    return () => {
      clearInterval(a);
      clearInterval(b);
      clearInterval(c);
    };
  }, [token, load]);

  // auto reset after 30 s without interaction
  const touch = useCallback(() => {
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => {
      setStep({ kind: 'list' });
      setQ('');
      setFound([]);
      void load();
    }, IDLE_MS);
  }, [load]);
  useEffect(() => {
    touch();
    return () => window.clearTimeout(idle.current);
  }, [step, touch]);

  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    if (!online) {
      const needle = q.trim().toLowerCase();
      return setFound(
        cache
          .filter((c) => c.displayName.toLowerCase().includes(needle))
          .slice(0, 5)
          .map((c) => ({ employeeRef: '', offlineRef: c.offlineRef, displayName: c.displayName })),
      );
    }
    const h = window.setTimeout(
      () =>
        void kapi<{ items: any[] }>('/kiosk/search', { query: { q: q.trim() } })
          .then((r) => setFound(r.items))
          .catch(() => setFound([])),
      250,
    );
    return () => window.clearTimeout(h);
  }, [q, online, cache]);

  // a badge reader types the badge id and presses Enter, like a keyboard
  useEffect(() => {
    if (step.kind !== 'list' || roster?.identification !== 'badge_pin' || !online) return;
    let buf = '';
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const at = Date.now();
      if (at - last > 150) buf = '';
      last = at;
      if (e.key === 'Enter') {
        const badge = buf;
        buf = '';
        if (badge.length < 4) return;
        void kapi<{ employeeRef: string; displayName: string }>('/kiosk/badge', { body: { badge } })
          .then((r) => pickRefRef.current(r.employeeRef, r.displayName))
          .catch((err) =>
            setNotice(
              (err as KioskError).code === 'NOT_FOUND'
                ? t('Badge unbekannt. Bitte Namen antippen.')
                : (err as KioskError).message,
            ),
          );
        return;
      }
      if (e.key.length === 1) buf += e.key;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step.kind, roster?.identification, online, t]);

  const clock = useMemo(
    () =>
      new Intl.DateTimeFormat('de-DE', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(now + offset)),
    [now, offset, tz],
  );

  if (!token || invalid)
    return (
      <Register
        onSave={(v) => {
          try {
            localStorage.setItem(KEY, v);
          } catch {
            /* ignore */
          }
          setToken(v);
          setInvalid(false);
        }}
        invalid={invalid}
      />
    );

  const reset = () => {
    setStep({ kind: 'list' });
    setQ('');
    setFound([]);
    void load();
  };
  const shiftLabel = (i: Item) =>
    i.plannedStart ? `${hm(i.plannedStart, tz)}–${hm(i.plannedEnd, tz)}` : t('Ungeplant');
  const offlineItems: Item[] = cache.map((c) => ({
    employeeRef: '',
    offlineRef: c.offlineRef,
    displayName: c.displayName,
    departmentName: null,
    plannedStart: null,
    plannedEnd: null,
    state: localStates()[c.offlineRef] ?? 'not_in',
  }));
  const listItems = online ? (roster?.items ?? []) : offlineItems;
  const pick = (i: Item) => {
    setNotice(null);
    if (!online) return setStep({ kind: 'action', item: i }); // the state is unknown offline: the person says what they do
    if (i.state === 'working' || i.state === 'on_break') {
      if (breakMode === 'start_stop') return setStep({ kind: 'action', item: i });
      return setStep({ kind: 'pin', item: i, action: 'out' });
    }
    setStep({ kind: 'pin', item: i, action: 'in' });
  };
  // search results and badge scans do not know whether the person is already clocked in
  const pickRef = async (employeeRef: string, displayName: string) => {
    let state: Item['state'] = 'not_in';
    try {
      state = (await kapi<{ state: Item['state'] }>('/kiosk/punch-status', { query: { employeeRef } })).state;
    } catch {
      /* fall back to clock-in; the server answers ALREADY_CLOCKED_IN if needed */
    }
    pick({ employeeRef, displayName, departmentName: null, plannedStart: null, plannedEnd: null, state });
  };
  pickRefRef.current = pickRef;
  const pickFound = (f: { employeeRef: string; offlineRef?: string; displayName: string }) =>
    f.offlineRef
      ? pick({
          employeeRef: '',
          offlineRef: f.offlineRef,
          displayName: f.displayName,
          departmentName: null,
          plannedStart: null,
          plannedEnd: null,
          state: 'not_in',
        })
      : void pickRef(f.employeeRef, f.displayName);

  return (
    <main
      style={{ flex: 1, padding: 'var(--space-4)', minHeight: '100vh' }}
      onPointerDown={touch}
      onKeyDown={touch}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 1024,
          minHeight: 700,
          margin: '0 auto',
          border: '2px solid var(--color-text)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--color-bg)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-4)',
            padding: 'var(--space-4) var(--space-6)',
            borderBottom: '2px solid var(--color-divider)',
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 800, marginRight: 'auto' }}>
            Trip Inn {roster?.hotelName} · {roster?.deviceName}
          </div>
          <LangSwitch />
          <div
            style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}
            data-testid="kiosk-clock"
          >
            {clock}
          </div>
        </div>
        {(!online || queueN > 0) && (
          <div
            role="status"
            data-testid="kiosk-offline-banner"
            style={{
              padding: 'var(--space-3) var(--space-6)',
              background: 'var(--color-text)',
              color: 'var(--color-bg)',
              fontWeight: 700,
              fontSize: 16,
            }}
          >
            {!online
              ? t('Keine Verbindung. Stempelungen werden auf dem Tablet gespeichert und später übertragen.')
              : t('Gespeicherte Stempelungen werden übertragen.')}{' '}
            {queueN > 0 ? t('Wartend: {{n}}', { n: queueN }) : ''}
          </div>
        )}
        {step.kind === 'list' && (
          <div
            style={{
              padding: 'var(--space-6)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-4)',
            }}
          >
            <h1 style={{ margin: 0, fontSize: 40 }}>{t('Tippe auf deinen Namen')}</h1>
            {roster?.identification === 'badge_pin' && online && (
              <div style={{ fontSize: 16 }} data-testid="kiosk-badge-hint">
                {t('Oder halte deinen Badge an den Leser.')}
              </div>
            )}
            {notice && (
              <div role="status" style={{ fontSize: 16, fontWeight: 700 }} data-testid="kiosk-notice">
                {notice}
              </div>
            )}
            <input
              className="input"
              style={{ fontSize: 18, minHeight: 52 }}
              placeholder={t('Nicht dabei? Namen suchen')}
              aria-label={t('Nicht dabei? Namen suchen')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              data-testid="kiosk-search"
            />
            {found.length > 0 && (
              <div style={{ border: '2px solid var(--color-divider)' }} data-testid="kiosk-found">
                {found.map((f) => (
                  <button
                    key={f.employeeRef}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      fontSize: 22,
                      fontWeight: 700,
                      padding: 'var(--space-3) var(--space-4)',
                      border: 0,
                      borderBottom: '1px solid var(--color-divider)',
                      background: 'var(--color-bg)',
                      cursor: 'pointer',
                    }}
                    onClick={() => pickFound(f)}
                  >
                    {f.displayName}
                  </button>
                ))}
              </div>
            )}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))',
                gap: 2,
                background: 'var(--color-divider)',
                border: '2px solid var(--color-divider)',
              }}
            >
              {listItems.map((i) => (
                <button
                  key={i.employeeRef || i.offlineRef}
                  data-testid={`kiosk-card-${i.displayName}`}
                  onClick={() => pick(i)}
                  style={{
                    textAlign: 'left',
                    border: 0,
                    background: 'var(--color-bg)',
                    padding: 'var(--space-4)',
                    minHeight: 120,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <span style={{ fontSize: 24, fontWeight: 800 }}>{i.displayName}</span>
                  <span style={{ fontSize: 15 }}>
                    {i.departmentName ? `${i.departmentName} · ` : ''}
                    {shiftLabel(i)}
                  </span>
                  <span
                    className={`tag ${i.state === 'working' || i.state === 'on_break' ? 'tag-accent' : 'tag-neutral'}`}
                    style={{ alignSelf: 'flex-start', marginTop: 'auto' }}
                  >
                    {t(
                      i.state === 'working'
                        ? 'Eingestempelt'
                        : i.state === 'on_break'
                          ? 'In der Pause'
                          : i.state === 'done'
                            ? 'Fertig'
                            : 'Noch nicht da',
                    )}
                  </span>
                </button>
              ))}
            </div>
            {listItems.length === 0 && (
              <div style={{ fontSize: 16 }}>{t('Gerade sind keine Schichten geplant. Nutze die Suche.')}</div>
            )}
          </div>
        )}
        {step.kind === 'action' && (
          <ActionStep
            item={step.item}
            online={online}
            breakMode={breakMode}
            onBack={reset}
            onPick={(action) => setStep({ kind: 'pin', item: step.item, action })}
          />
        )}
        {step.kind === 'pin' && (
          <PinStep
            item={step.item}
            action={step.action}
            online={online}
            cache={cache}
            pinLength={roster?.pinLength ?? 6}
            sub={shiftLabel(step.item)}
            onBack={reset}
            onDone={(s) => {
              setQueueN(queueLength());
              setStep(s);
            }}
            nowIso={() => new Date(Date.now() + offset).toISOString()}
            tz={tz}
          />
        )}
        {step.kind === 'offbreak' && (
          <BreakStep
            step={{
              kind: 'break',
              item: step.item,
              out: {
                confirmToken: '',
                grossMinutes: 0,
                requiredBreakMinutes: 0,
                suggestedBreakMinutes: 30,
                options: [0, 15, 30, 45, 60],
              },
            }}
            onBack={reset}
            onDone={() => undefined}
            offlineSubmit={async (brk, reason) => {
              await enqueue({
                action: 'out',
                offlineRef: step.item.offlineRef!,
                displayName: step.item.displayName,
                pin: step.pin,
                occurredAt: new Date(Date.now() + offset).toISOString(),
                breakMinutes: brk,
                reason,
              });
              setQueueN(queueLength());
              setStep({
                kind: 'saved',
                item: step.item,
                action: 'out',
                at: new Date(Date.now() + offset).toISOString(),
                offline: true,
              });
            }}
          />
        )}
        {step.kind === 'saved' && <SavedDone step={step} tz={tz} onDone={reset} />}
        {step.kind === 'break' && (
          <BreakStep
            step={step}
            onDone={(res) =>
              setStep({ kind: 'out', item: step.item, res, at: new Date(Date.now() + offset).toISOString() })
            }
            onBack={reset}
          />
        )}
        {step.kind === 'in' && <InDone step={step} tz={tz} onDone={reset} />}
        {step.kind === 'out' && (
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
              {t('Ausgestempelt')} {hm(step.at, tz)}
            </h1>
            <div style={{ fontSize: 22 }}>
              {step.item.displayName} · {fnum(step.res.paidHours, 2)} {t('Std.')} {t('bezahlt')}
            </div>
            {step.res.approvalStatus === 'pending' && (
              <div
                style={{ fontSize: 18, borderTop: '2px solid var(--color-bg)', paddingTop: 'var(--space-3)' }}
              >
                {t('Deine Leitung sieht das')}
              </div>
            )}
            <button onClick={reset} style={doneBtn}>
              {t('Fertig')}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

const doneBtn: React.CSSProperties = {
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

function Register({ onSave, invalid }: { onSave: (t: string) => void; invalid: boolean }) {
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

function ActionStep({
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

function SavedDone({
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

function PinStep({
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

function InDone({
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

function BreakStep({
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
