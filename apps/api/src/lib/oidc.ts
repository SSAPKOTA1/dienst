import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError } from './errors';

// Minimal OpenID Connect relying party: authorization code flow with PKCE and client_secret_post.

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const TIMEOUT_MS = 5000;

/** The issuer must be https; plain http is only accepted outside production (tests, local IdPs). */
export function assertIssuer(issuer: string, production: boolean): URL {
  let u: URL;
  try {
    u = new URL(issuer);
  } catch {
    throw new AppError('VALIDATION', 'The issuer is not a valid URL');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && !production))
    throw new AppError('VALIDATION', 'The issuer must use https');
  return u;
}

export async function discover(issuer: string): Promise<Discovery> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new AppError('CONFLICT', 'The identity provider could not be reached');
  const d = (await res.json()) as Partial<Discovery>;
  if (
    !d.authorization_endpoint ||
    !d.token_endpoint ||
    !d.jwks_uri ||
    (d.issuer ?? '').replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')
  )
    throw new AppError('CONFLICT', 'The identity provider metadata is invalid');
  return d as Discovery;
}

export const b64url = (b: Buffer) => b.toString('base64url');

export function pkcePair() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function authorizationUrl(
  d: Discovery,
  p: { clientId: string; redirectUri: string; state: string; nonce: string; challenge: string },
): string {
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', p.state);
  u.searchParams.set('nonce', p.nonce);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export interface IdClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  amr?: string[];
}

export async function redeemCode(
  d: Discovery,
  p: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    verifier: string;
    nonce: string;
  },
): Promise<IdClaims> {
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code_verifier: p.verifier,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new AppError('UNAUTHENTICATED', 'The identity provider rejected the login');
  const tok = (await res.json()) as { id_token?: string };
  if (!tok.id_token) throw new AppError('UNAUTHENTICATED', 'The identity provider sent no ID token');
  try {
    const { payload } = await jwtVerify(tok.id_token, createRemoteJWKSet(new URL(d.jwks_uri)), {
      issuer: d.issuer,
      audience: p.clientId,
    });
    if (payload.nonce !== p.nonce) throw new Error('nonce');
    if (!payload.sub) throw new Error('sub');
    return payload as unknown as IdClaims;
  } catch {
    throw new AppError('UNAUTHENTICATED', 'The ID token is invalid');
  }
}
