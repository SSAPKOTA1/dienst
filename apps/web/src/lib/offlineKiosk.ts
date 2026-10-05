// Offline queue of the tablet. Punches taken without a connection are kept here and sent in order
// once the network is back. The PIN is stored encrypted (AES-GCM, key kept non-extractable in
// IndexedDB) and only for as long as the punch waits. The server verifies everything on sync and
// sends every offline punch to review.

export type OfflineAction = 'in' | 'out' | 'break_start' | 'break_end';

export interface OfflineRosterItem {
  displayName: string;
  offlineRef: string;
}
export interface QueuedPunch {
  clientId: string;
  action: OfflineAction;
  occurredAt: string;
  offlineRef: string;
  displayName: string;
  pinEnc: string; // base64(iv) + '.' + base64(ciphertext)
  breakMinutes?: number;
  reason?: string;
}

const QUEUE = 'kioskQueue';
const ROSTER = 'kioskOfflineRoster';
const LOCAL_STATE = 'kioskLocalState';

const read = <T>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage full or blocked: the punch is then not queued, the caller shows an error */
    throw new Error('STORAGE');
  }
};

// ---- key in IndexedDB
function idb(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open('dienst-kiosk', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function getKey(): Promise<CryptoKey> {
  const db = await idb();
  const existing = await new Promise<CryptoKey | undefined>((ok, fail) => {
    const q = db.transaction('keys').objectStore('keys').get('pin');
    q.onsuccess = () => ok(q.result as CryptoKey | undefined);
    q.onerror = () => fail(q.error);
  });
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  await new Promise<void>((ok, fail) => {
    const t = db.transaction('keys', 'readwrite');
    t.objectStore('keys').put(key, 'pin');
    t.oncomplete = () => ok();
    t.onerror = () => fail(t.error);
  });
  return key;
}
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptPin(pin: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await getKey(),
    new TextEncoder().encode(pin),
  );
  return `${b64(iv)}.${b64(ct)}`;
}
export async function decryptPin(enc: string): Promise<string> {
  const [iv, ct] = enc.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await getKey(), unb64(ct));
  return new TextDecoder().decode(pt);
}

// ---- roster cache and local state
export const saveOfflineRoster = (items: OfflineRosterItem[]) => write(ROSTER, { at: Date.now(), items });
export const loadOfflineRoster = (): OfflineRosterItem[] =>
  read<{ items: OfflineRosterItem[] }>(ROSTER, { items: [] }).items;
export type LocalState = 'working' | 'on_break' | 'not_in';
export const localStates = () => read<Record<string, LocalState>>(LOCAL_STATE, {});
export const setLocalState = (ref: string, s: LocalState) =>
  write(LOCAL_STATE, { ...localStates(), [ref]: s });
export const clearLocalStates = () => write(LOCAL_STATE, {});

// ---- queue
export const loadQueue = (): QueuedPunch[] => read<QueuedPunch[]>(QUEUE, []);
export const queueLength = () => loadQueue().length;

export async function enqueue(p: {
  action: OfflineAction;
  offlineRef: string;
  displayName: string;
  pin: string;
  occurredAt: string;
  breakMinutes?: number;
  reason?: string;
}): Promise<void> {
  const item: QueuedPunch = {
    clientId: crypto.randomUUID(),
    action: p.action,
    occurredAt: p.occurredAt,
    offlineRef: p.offlineRef,
    displayName: p.displayName,
    pinEnc: await encryptPin(p.pin),
    breakMinutes: p.breakMinutes,
    reason: p.reason,
  };
  write(QUEUE, [...loadQueue(), item]);
  setLocalState(
    p.offlineRef,
    p.action === 'in' || p.action === 'break_end'
      ? 'working'
      : p.action === 'break_start'
        ? 'on_break'
        : 'not_in',
  );
}

export interface FlushResult {
  applied: number;
  rejected: number;
  left: number;
}

/** Sends the queue. `send` posts to /kiosk/offline-sync and throws on network trouble (the queue is then kept). */
export async function flushQueue(
  send: (items: unknown[]) => Promise<{ results: Array<{ clientId: string; status: string }> }>,
): Promise<FlushResult> {
  const queue = loadQueue();
  if (!queue.length) return { applied: 0, rejected: 0, left: 0 };
  const items = await Promise.all(
    queue.map(async (q) => ({
      clientId: q.clientId,
      action: q.action,
      occurredAt: q.occurredAt,
      offlineRef: q.offlineRef,
      pin: await decryptPin(q.pinEnc),
      breakMinutes: q.breakMinutes,
      reason: q.reason,
    })),
  );
  const res = await send(items);
  const done = new Set(res.results.map((r) => r.clientId));
  write(
    QUEUE,
    queue.filter((q) => !done.has(q.clientId)),
  );
  return {
    applied: res.results.filter((r) => r.status === 'applied' || r.status === 'duplicate').length,
    rejected: res.results.filter((r) => r.status === 'rejected').length,
    left: queue.length - done.size,
  };
}
