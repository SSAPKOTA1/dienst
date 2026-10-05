import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { AppError } from './errors';

/**
 * Guard for every request the server makes to an address an administrator typed in (the SSO issuer and the
 * endpoints it announces). Without it such a URL could point the server at internal services, cloud metadata
 * (169.254.169.254) or localhost. The check is done on the addresses that are really connected to (so a
 * host name that later resolves to an internal address is caught too), redirects are not followed, and
 * answers are size and time limited.
 */
export interface OutboundPolicy {
  /** true only for development and tests, or an explicit opt-in for an identity provider inside the network */
  allowPrivate: boolean;
}

const blocked = new BlockList();
const v4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
for (const [a, n] of v4) blocked.addSubnet(a, n, 'ipv4');
const v6: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 embeds an IPv4 address
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];
for (const [a, n] of v6) blocked.addSubnet(a, n, 'ipv6');

/** IPv4 inside IPv6 (::ffff:a.b.c.d, 64:ff9b::a.b.c.d) must be judged as the IPv4 address. */
function embeddedV4(ip: string): string | null {
  const m = ip.toLowerCase().match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return m[1];
  const h = ip.toLowerCase().match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (h) {
    const a = parseInt(h[1], 16);
    const b = parseInt(h[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/** True for a globally routable address. */
export function isPublicIp(ip: string): boolean {
  const fam = isIP(ip);
  if (!fam) return false;
  const inner = fam === 6 ? embeddedV4(ip) : null;
  if (inner) return isPublicIp(inner);
  return !blocked.check(ip, fam === 4 ? 'ipv4' : 'ipv6');
}

export function guardedLookup(policy: OutboundPolicy) {
  return (
    hostname: string,
    options: { all?: boolean; family?: number } | number,
    cb: (err: Error | null, address?: string | LookupAddress[], family?: number) => void,
  ) => {
    const opts = typeof options === 'number' ? { family: options } : (options ?? {});
    dnsLookup(hostname, { ...opts, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = addrs as LookupAddress[];
      if (!policy.allowPrivate && list.some((a) => !isPublicIp(a.address)))
        return cb(new AppError('VALIDATION', 'The address is not reachable from outside the network'));
      if (opts.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
}

/** Validates the URL itself (scheme, no credentials, no internal literal address). Host names are checked when connecting. */
export function assertOutboundUrl(raw: string, policy: OutboundPolicy): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError('VALIDATION', 'The URL is not valid');
  }
  if (u.username || u.password) throw new AppError('VALIDATION', 'The URL must not contain credentials');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && policy.allowPrivate))
    throw new AppError('VALIDATION', 'The URL must use https');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!policy.allowPrivate) {
    if (isIP(host) && !isPublicIp(host))
      throw new AppError('VALIDATION', 'The address is not reachable from outside the network');
    if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host))
      throw new AppError('VALIDATION', 'The address is not reachable from outside the network');
  }
  return u;
}

export interface SafeResponse {
  status: number;
  body: string;
}

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 5000;

export async function safeRequest(
  url: string,
  policy: OutboundPolicy,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string } = {},
): Promise<SafeResponse> {
  const u = assertOutboundUrl(url, policy);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise<SafeResponse>((resolve, reject) => {
    const req = lib.request(
      u,
      {
        method: init.method ?? 'GET',
        headers: {
          ...(init.headers ?? {}),
          ...(init.body ? { 'content-length': Buffer.byteLength(init.body) } : {}),
        },
        lookup: guardedLookup(policy) as never,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.destroy();
          return reject(
            new AppError('CONFLICT', 'The server answered with a redirect, which is not followed'),
          );
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            res.destroy();
            reject(new AppError('CONFLICT', 'The answer is too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new AppError('CONFLICT', 'The server did not answer in time')));
    req.on('error', (e) =>
      reject(e instanceof AppError ? e : new AppError('CONFLICT', 'The server could not be reached')),
    );
    if (init.body) req.write(init.body);
    req.end();
  });
}
