import { isIP } from 'node:net';

/**
 * TRUST_PROXY decides whose `X-Forwarded-For` the app believes. Believing it blindly lets any client choose
 * its own address, which would defeat the web-punch network check, IP-based rate limits and the audit trail.
 *
 *   false            trust nothing: the address of the TCP peer is the client (default)
 *   N (integer)      N reverse proxies in front; the address N hops from the app is the client
 *   a, b, c ...      addresses or CIDR ranges of the proxies; the first address that is not one of them is the client
 *   true             trust every hop (the client can forge its address): refused in production
 */
export type TrustProxy = boolean | number | string[];

const CIDR = /^(.+)\/(\d{1,3})$/;

function validAddress(entry: string): boolean {
  const m = entry.match(CIDR);
  const host = m ? m[1] : entry;
  const fam = isIP(host);
  if (!fam) return false;
  if (!m) return true;
  const bits = Number(m[2]);
  return bits <= (fam === 4 ? 32 : 128);
}

export function parseTrustProxy(raw: string | undefined, production: boolean): TrustProxy {
  const v = (raw ?? '').trim();
  if (!v || v === 'false' || v === '0') return false;
  if (v === 'true') {
    if (production)
      throw new Error(
        'TRUST_PROXY=true trusts every hop and lets clients forge their address; use the number of proxies (e.g. 1) or their addresses',
      );
    return true;
  }
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n > 5) throw new Error('TRUST_PROXY: more than 5 proxy hops looks wrong');
    return n;
  }
  const list = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = list.find((e) => !validAddress(e));
  if (bad) throw new Error(`TRUST_PROXY: "${bad}" is not an IP address or CIDR range`);
  return list;
}
