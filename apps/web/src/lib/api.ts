export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, any> = {},
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

export const getToken = () => accessToken;
export function setToken(t: string | null) {
  accessToken = t;
  listeners.forEach((l) => l());
}
export const onAuthChange = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

async function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const r = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!r.ok) return false;
      setToken((await r.json()).accessToken);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export interface ReqOpts {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null | Array<string | number>>;
  token?: string | null;
  noRetry?: boolean;
  headers?: Record<string, string>;
}

export function buildUrl(path: string, query?: ReqOpts['query']) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const qs = q.toString();
  return `/api/v1${path}${qs ? `?${qs}` : ''}`;
}

async function raw(path: string, o: ReqOpts): Promise<Response> {
  const token = o.token === undefined ? accessToken : o.token;
  return fetch(buildUrl(path, o.query), {
    method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'),
    credentials: 'include',
    headers: {
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...o.headers,
    },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
}

async function toError(r: Response): Promise<ApiError> {
  let b: any = null;
  try {
    b = await r.json();
  } catch {
    /* no body */
  }
  return new ApiError(
    r.status,
    b?.error?.code ?? 'INTERNAL',
    b?.error?.message ?? r.statusText,
    b?.error?.details ?? {},
  );
}

export async function api<T = any>(path: string, o: ReqOpts = {}): Promise<T> {
  let r = await raw(path, o);
  if (r.status === 401 && !o.noRetry && o.token === undefined && !path.startsWith('/auth/')) {
    if (await refresh()) r = await raw(path, o);
    else setToken(null);
  }
  if (!r.ok) throw await toError(r);
  if (r.status === 204) return undefined as T;
  const ct = r.headers.get('content-type') ?? '';
  return (ct.includes('json') ? r.json() : r.blob()) as Promise<T>;
}

/** Fetches a file (PDF, XLSX, CSV) with the bearer token and triggers a browser download. */
export async function download(path: string, query: ReqOpts['query'], filename: string) {
  let r = await raw(path, { query });
  if (r.status === 401 && (await refresh())) r = await raw(path, { query });
  if (!r.ok) throw await toError(r);
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export async function tryRestoreSession(): Promise<boolean> {
  return refresh();
}

import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';

export function useGet<T = any>(
  path: string | null,
  query?: ReqOpts['query'],
  opts: { enabled?: boolean; refetchInterval?: number } = {},
) {
  return useQuery<T>({
    queryKey: ['api', path, query ?? null],
    queryFn: () => api<T>(path!, { query }),
    enabled: path !== null && (opts.enabled ?? true),
    refetchInterval: opts.refetchInterval,
  });
}

export function useSend<TBody = any, TRes = any>(
  method: string,
  path: string | ((b: TBody) => string),
  invalidate: QueryKey[] = [['api']],
) {
  const qc = useQueryClient();
  return useMutation<TRes, ApiError, TBody>({
    mutationFn: (body) =>
      api<TRes>(typeof path === 'function' ? path(body) : path, {
        method,
        body: method === 'DELETE' ? undefined : (body ?? {}),
      }),
    onSuccess: () => invalidate.forEach((k) => void qc.invalidateQueries({ queryKey: k })),
  });
}
