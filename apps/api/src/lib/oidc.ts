import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { AppError } from './errors';
import { assertOutboundUrl, safeRequest, type OutboundPolicy } from './ssrf';

// Minimal OpenID Connect relying party: authorization code flow with PKCE and client_secret_post.

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** The issuer must be https (plain http only where private addresses are allowed: development and tests). */
export function assertIssuer(issuer: string, policy: OutboundPolicy): URL {
  return assertOutboundUrl(issuer, policy);
}

async function getJson<T>(url: string, policy: OutboundPolicy): Promise<T> {
  const res = await safeRequest(url, policy, { headers: { accept: 'application/json' } });
  if (res.status < 200 || res.status >= 300)
    throw new AppError('CONFLICT', 'The identity provider could not be reached');
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new AppError('CONFLICT', 'The identity provider metadata is invalid');
  }
}

export async function discover(issuer: string, policy: OutboundPolicy): Promise<Discovery> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const d = await getJson<Partial<Discovery>>(url, policy);
  if (
    !d.authorization_endpoint ||
    !d.token_endpoint ||
    !d.jwks_uri ||
    (d.issuer ?? '').replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')
  )
    throw new AppError('CONFLICT', 'The identity provider metadata is invalid');
  // the endpoints the server will call must pass the same rules as the issuer
  assertOutboundUrl(d.token_endpoint, policy);
  assertOutboundUrl(d.jwks_uri, policy);
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
  policy: OutboundPolicy,
  p: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    verifier: string;
    nonce: string;
  },
): Promise<IdClaims> {
  const res = await safeRequest(d.token_endpoint, policy, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code_verifier: p.verifier,
    }).toString(),
  });
  if (res.status < 200 || res.status >= 300)
    throw new AppError('UNAUTHENTICATED', 'The identity provider rejected the login');
  let tok: { id_token?: string };
  try {
    tok = JSON.parse(res.body) as { id_token?: string };
  } catch {
    throw new AppError('UNAUTHENTICATED', 'The identity provider sent no ID token');
  }
  if (!tok.id_token) throw new AppError('UNAUTHENTICATED', 'The identity provider sent no ID token');
  const jwks = await getJson<JSONWebKeySet>(d.jwks_uri, policy);
  try {
    const { payload } = await jwtVerify(tok.id_token, createLocalJWKSet(jwks), {
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
