import { buildUrl } from '../../lib/api';
import { type OfflineAction } from '../../lib/offlineKiosk';

export const KEY = 'kioskToken';
export const IDLE_MS = 30_000;

export interface Item {
  employeeRef: string;
  offlineRef?: string;
  displayName: string;
  departmentName: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  state: 'not_in' | 'working' | 'on_break' | 'done';
}
export interface Roster {
  serverTime: string;
  timezone: string;
  hotelName: string;
  deviceName: string;
  pinLength: number;
  breakMode?: 'confirm_at_clock_out' | 'start_stop';
  identification?: 'name_pin' | 'badge_pin';
  items: Item[];
}

export class KioskError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, any>,
    message: string,
  ) {
    super(message);
  }
}

export const getToken = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

export async function kapi<T = any>(
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

export type PunchAction = OfflineAction;

export type Step =
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

export const hm = (iso: string | null, tz: string) =>
  iso
    ? new Intl.DateTimeFormat('de-DE', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(iso))
    : '';
