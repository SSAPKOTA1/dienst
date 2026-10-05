import { BlockList, isIP } from 'node:net';
import { z } from 'zod';

/** True when `ip` lies inside one of the CIDR ranges. An empty or missing list never matches. */
export function ipInCidrs(ip: string, cidrs: string[] | null | undefined): boolean {
  if (!cidrs?.length) return false;
  const bare = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const fam = isIP(bare);
  if (!fam) return false;
  const bl = new BlockList();
  for (const c of cidrs) {
    const [addr, bits] = c.split('/');
    const f = isIP(addr);
    if (!f) continue;
    if (bits === undefined) bl.addAddress(addr, f === 4 ? 'ipv4' : 'ipv6');
    else bl.addSubnet(addr, Number(bits), f === 4 ? 'ipv4' : 'ipv6');
  }
  return bl.check(bare, fam === 4 ? 'ipv4' : 'ipv6');
}

export const cidrList = z
  .array(
    z.string().refine((c) => {
      const [a, b] = c.split('/');
      const f = isIP(a);
      if (!f) return false;
      if (b === undefined) return true;
      const n = Number(b);
      return Number.isInteger(n) && n >= 0 && n <= (f === 4 ? 32 : 128);
    }, 'Not a valid IP address or CIDR range'),
  )
  .max(20);
