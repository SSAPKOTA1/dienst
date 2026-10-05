import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fnum } from '../../lib/format';
import { LangSwitch } from '../../components/LangSwitch';
import {
  clearLocalStates,
  enqueue,
  flushQueue,
  loadOfflineRoster,
  localStates,
  queueLength,
  saveOfflineRoster,
  type OfflineRosterItem,
} from '../../lib/offlineKiosk';
import { IDLE_MS, Item, KEY, KioskError, Roster, Step, getToken, hm, kapi } from './common';
import { ActionStep, BreakStep, InDone, PinStep, Register, SavedDone, doneBtn } from './Steps';

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
        void kapi<{ items: Item[] }>('/kiosk/search', { query: { q: q.trim() } })
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
