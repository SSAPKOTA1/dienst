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

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signAccessToken(secret: string, c: TokenClaims, ttl = '15m'): Promise<string> {
  const { sub, ...rest } = c;
  return new SignJWT({ ...rest })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(sub))
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(key(secret));
}

export async function verifyToken<T extends Record<string, unknown> = Record<string, unknown>>(
  secret: string,
  token: string,
): Promise<(T & { sub: string }) | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    return payload as unknown as T & { sub: string };
  } catch {
    return null;
  }
}

/** Short-lived signed payload (kiosk employeeRef and confirmToken). */
export async function signPayload(
  secret: string,
  payload: Record<string, unknown>,
  ttl: string,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(key(secret));
}
