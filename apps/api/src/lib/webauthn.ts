import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { FastifyInstance } from 'fastify';
import { AppError } from './errors';
import { signPayload, verifyToken } from './jwt';

/**
 * Security keys and passkeys as a second factor. The relying party is the web app's own origin (WEB_ORIGIN): the
 * browser only releases an assertion to a page of that origin, which is what makes it phishing resistant.
 * Challenges are not stored: they travel inside a short signed token (purpose `webauthn`) that the client sends back.
 */
const CHALLENGE_TTL = '3m';

export const rpOf = (app: FastifyInstance) => {
  const url = new URL(app.cfg.WEB_ORIGIN);
  return { rpID: url.hostname, origin: url.origin, rpName: 'Trip Inn Dienstplan' };
};

type Kind = 'reg' | 'auth';
const sign = (app: FastifyInstance, kind: Kind, userId: number, challenge: string) =>
  signPayload(app.keys.signing('webauthn'), { kind, uid: userId, challenge }, CHALLENGE_TTL);

async function open(app: FastifyInstance, token: string, kind: Kind, userId: number): Promise<string> {
  const c = await verifyToken<{ kind?: string; uid?: number; challenge?: string }>(
    app.keys.verifying('webauthn'),
    token,
  );
  if (!c || c.kind !== kind || c.uid !== userId || !c.challenge)
    throw new AppError('UNAUTHENTICATED', 'The security key request expired. Please try again.');
  return c.challenge;
}

export interface StoredCredential {
  credential_id: string;
  public_key: Buffer;
  counter: string | number;
  transports: string[] | null;
}

export async function registrationOptions(
  app: FastifyInstance,
  user: { id: number; label: string },
  existing: Array<{ credential_id: string; transports: string[] | null }>,
) {
  const rp = rpOf(app);
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: user.label,
    userID: new TextEncoder().encode(`user-${user.id}`),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({
      id: c.credential_id,
      transports: (c.transports ?? undefined) as never,
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  return { options, challengeToken: await sign(app, 'reg', user.id, options.challenge) };
}

export async function verifyRegistration(
  app: FastifyInstance,
  userId: number,
  challengeToken: string,
  response: RegistrationResponseJSON,
) {
  const rp = rpOf(app);
  const expectedChallenge = await open(app, challengeToken, 'reg', userId);
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: false,
  }).catch(() => null);
  if (!v?.verified || !v.registrationInfo)
    throw new AppError('UNAUTHENTICATED', 'The security key could not be verified');
  const c = v.registrationInfo.credential;
  return {
    credentialId: c.id,
    publicKey: Buffer.from(c.publicKey),
    counter: c.counter,
    transports: c.transports ?? null,
  };
}

export async function authenticationOptions(app: FastifyInstance, userId: number, creds: StoredCredential[]) {
  const rp = rpOf(app);
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: 'preferred',
    allowCredentials: creds.map((c) => ({
      id: c.credential_id,
      transports: (c.transports ?? undefined) as never,
    })),
  });
  return { options, challengeToken: await sign(app, 'auth', userId, options.challenge) };
}

/** Returns the used credential's id and its new counter, or null when the assertion is not valid for this user. */
export async function verifyAuthentication(
  app: FastifyInstance,
  userId: number,
  challengeToken: string,
  response: AuthenticationResponseJSON,
  creds: StoredCredential[],
): Promise<{ credentialId: string; counter: number } | null> {
  const rp = rpOf(app);
  const expectedChallenge = await open(app, challengeToken, 'auth', userId).catch(() => null);
  const cred = creds.find((c) => c.credential_id === response.id);
  if (!expectedChallenge || !cred) return null;
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: false,
    credential: {
      id: cred.credential_id,
      publicKey: new Uint8Array(cred.public_key),
      counter: Number(cred.counter),
      transports: (cred.transports ?? undefined) as never,
    },
  }).catch(() => null);
  if (!v?.verified) return null;
  return { credentialId: cred.credential_id, counter: v.authenticationInfo.newCounter };
}
