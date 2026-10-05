import { SignJWT, jwtVerify } from 'jose';
import type { Role } from '@dienst/shared';

export interface TokenClaims {
  sub: number;
  role?: Role;
  pre?: boolean;
  /** pre-token of an SSO login whose identity provider vouched for a second factor */
  ssoMfa?: boolean;
  employeeId?: number;
  companyIds?: number[];
  hotelIds?: number[];
}

export async function signAccessToken(key: Uint8Array, c: TokenClaims, ttl = '15m'): Promise<string> {
  const { sub, ...rest } = c;
  return new SignJWT({ ...rest })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(sub))
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(key);
}

export async function verifyToken<T extends Record<string, unknown> = Record<string, unknown>>(
  keys: Uint8Array[],
  token: string,
): Promise<(T & { sub: string }) | null> {
  for (const key of keys) {
    try {
      const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
      return payload as unknown as T & { sub: string };
    } catch {
      /* wrong key (or a bad token): try the next secret of a rotation */
    }
  }
  return null;
}

/** Short-lived signed payload (kiosk employeeRef and confirmToken). */
export async function signPayload(
  key: Uint8Array,
  payload: Record<string, unknown>,
  ttl: string,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(key);
}
