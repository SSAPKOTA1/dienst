import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  ctxHolder,
  employeeTokens,
  planFixture,
  startApp,
  stopApp,
  type PlanFx,
  type TestCtx,
} from './helpers';

// A tiny OpenID Connect provider: discovery, JWKS, token endpoint with PKCE and client secret.
const CLIENT_ID = 'dienst-test';
const CLIENT_SECRET = 'top-secret-value';
interface IdpCode {
  nonce: string;
  challenge: string;
  claims: Record<string, unknown>;
}
const codes = new Map<string, IdpCode>();
let idp: Server;
let issuer = '';
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let jwk: JWK;
let idpDown = false;

async function startIdp() {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  idp = createServer((req, res) => {
    const url = new URL(req.url!, issuer);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (idpDown) return send(503, {});
    if (url.pathname === '/.well-known/openid-configuration')
      return send(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    if (url.pathname === '/jwks') return send(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        const f = new URLSearchParams(raw);
        const c = codes.get(f.get('code') ?? '');
        const verifierOk =
          !!c &&
          createHash('sha256')
            .update(f.get('code_verifier') ?? '')
            .digest('base64url') === c.challenge;
        if (!c || !verifierOk || f.get('client_secret') !== CLIENT_SECRET || f.get('client_id') !== CLIENT_ID)
          return send(400, { error: 'invalid_grant' });
        codes.delete(f.get('code')!);
        const id = await new SignJWT({ nonce: c.nonce, ...c.claims })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(issuer)
          .setAudience(CLIENT_ID)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        send(200, { id_token: id, token_type: 'Bearer' });
      });
      return;
    }
    send(404, {});
  });
  await new Promise<void>((ok) => idp.listen(0, '127.0.0.1', ok));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
}

let ctx: TestCtx;
let fx: PlanFx;
let emp: Record<string, string>;

beforeAll(async () => {
  await startIdp();
  ctx = await startApp({ now: new Date('2026-10-04T10:00:00Z') });
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  emp = await employeeTokens(ctx, fx, ['maria', 'jon']);
});
afterAll(async () => {
  await stopApp(ctx);
  await new Promise((ok) => idp.close(ok));
});

const cookieOf = (res: { headers: Record<string, any> }) =>
  [res.headers['set-cookie']]
    .flat()
    .filter(Boolean)
    .map((c: string) => c.split(';')[0])
    .join('; ');

/** Runs the browser part of the flow against the real API and the mock IdP. */
async function ssoLogin(
  claims: Record<string, unknown>,
  o: { company?: number; mutateState?: boolean; dropCookie?: boolean; mutateNonce?: boolean } = {},
) {
  const start = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/auth/sso/start?company=${o.company ?? fx.companyA}`,
  });
  if (start.statusCode !== 302) return { start, loc: new URL(start.headers.location as string) };
  const loc = new URL(start.headers.location as string);
  if (!loc.href.startsWith(issuer)) return { start, loc };
  const code = randomUUID();
  codes.set(code, {
    nonce: o.mutateNonce ? 'other' : loc.searchParams.get('nonce')!,
    challenge: loc.searchParams.get('code_challenge')!,
    claims,
  });
  const cb = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/auth/sso/callback?code=${code}&state=${o.mutateState ? 'forged' : loc.searchParams.get('state')}`,
    headers: o.dropCookie ? {} : { cookie: cookieOf(start) },
  });
  const back = new URL(cb.headers.location as string);
  return { start, loc, cb, back, ticket: new URLSearchParams(back.hash.slice(1)).get('ticket') };
}
const exchange = (ticket: string) =>
  ctx.app
    .inject({ method: 'POST', url: '/api/v1/auth/sso/exchange', payload: { ticket } })
    .then((r) => ({ status: r.statusCode, body: r.json() as any }));
const configure = (over: Record<string, unknown> = {}, token = fx.adminA.token) =>
  call(ctx, 'PUT', '/sso/provider', token, {
    companyId: fx.companyA,
    issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    ...over,
  });

describe('configuration', () => {
  it('is for administrators of the company, checks the issuer and never returns the secret', async () => {
    expect((await configure({}, emp.maria)).status).toBe(403);
    expect((await configure({}, fx.mgrA1.token)).status).toBe(403);
    expect((await configure({}, fx.adminB.token)).status).toBe(403);
    expect((await configure({ issuer: 'ftp://x.example' })).status).toBe(400);
    expect((await configure({ clientSecret: undefined })).status).toBe(400); // first time: secret needed
    idpDown = true;
    expect((await configure()).status).toBe(409); // IdP unreachable
    idpDown = false;
    const ok = await configure();
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ companyId: fx.companyA, issuer, clientId: CLIENT_ID, enabled: true });
    expect(JSON.stringify(ok.body)).not.toContain(CLIENT_SECRET);
    const row = await ctx.db.selectFrom('sso_provider').selectAll().executeTakeFirstOrThrow();
    expect(Buffer.from(row.client_secret_enc).toString('utf8')).not.toContain(CLIENT_SECRET);
    const get = await call(ctx, 'GET', `/sso/provider?companyId=${fx.companyA}`, fx.adminA.token);
    expect(get.body.clientId).toBe(CLIENT_ID);
    expect(JSON.stringify(get.body)).not.toContain(CLIENT_SECRET);
    expect((await call(ctx, 'GET', `/sso/provider?companyId=${fx.companyA}`, fx.adminB.token)).status).toBe(
      403,
    );
    // updating without a new secret keeps the old one
    expect((await configure({ clientSecret: undefined, enabled: true })).status).toBe(200);
  });
});

describe('login with the identity provider', () => {
  it('links an existing account by verified e-mail, then recognises the subject; tickets work once', async () => {
    const a = await ssoLogin({ sub: 'sub-maria', email: 'MARIA@emp.test', email_verified: true });
    expect(a.start.statusCode).toBe(302);
    expect(a.loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(a.loc.searchParams.get('redirect_uri')).toContain('/api/v1/auth/sso/callback');
    expect(a.start.headers['set-cookie']).toContain('HttpOnly');
    expect(a.back!.pathname).toBe('/login/sso');
    expect(a.ticket).toBeTruthy();
    const ex = await exchange(a.ticket!);
    expect(ex.status).toBe(200);
    expect(ex.body.availableRoles).toEqual([
      expect.objectContaining({ role: 'employee', employeeId: fx.emp.maria }),
    ]);
    const me = await call(ctx, 'GET', '/me', ex.body.accessToken);
    expect(me.status).toBe(200);
    expect((await exchange(a.ticket!)).status).toBe(401); // single use
    expect(await ctx.db.selectFrom('sso_identity').select('subject').execute()).toEqual([
      { subject: 'sub-maria' },
    ]);
    // the e-mail changes at the IdP: the subject still matches
    const b = await ssoLogin({ sub: 'sub-maria', email: 'other@x.test', email_verified: false });
    expect((await exchange(b.ticket!)).status).toBe(200);
    const actions = (await ctx.db.selectFrom('audit_log').select('action').execute()).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['sso_linked', 'sso_login', 'sso_exchange']));
  });

  it('never creates accounts and never links unverified, unknown or foreign accounts', async () => {
    for (const claims of [
      { sub: 'x1', email: 'nobody@emp.test', email_verified: true },
      { sub: 'x2', email: 'jon@emp.test', email_verified: false },
      { sub: 'x3', email_verified: true },
      { sub: 'x4', email: 'admin.b@test.dev', email_verified: true }, // other company
    ]) {
      const r = await ssoLogin(claims);
      expect(r.cb!.statusCode).toBe(302);
      expect(r.back!.pathname).toBe('/login');
      expect(r.back!.searchParams.get('sso_error')).toBe('no_account');
    }
    expect((await ctx.db.selectFrom('user_account').select('id').execute()).length).toBeLessThan(20);
    // the same IdP subject cannot take over a second account
    const second = await ssoLogin({ sub: 'sub-other', email: 'maria@emp.test', email_verified: true });
    expect(second.back!.searchParams.get('sso_error')).toBe('no_account');
  });

  it('rejects forged state, a missing cookie, a wrong nonce and a failing IdP', async () => {
    const ok = { sub: 'sub-jon', email: 'jon@emp.test', email_verified: true };
    expect((await ssoLogin(ok, { mutateState: true })).back!.searchParams.get('sso_error')).toBe('denied');
    expect((await ssoLogin(ok, { dropCookie: true })).back!.searchParams.get('sso_error')).toBe('expired');
    expect((await ssoLogin(ok, { mutateNonce: true })).back!.searchParams.get('sso_error')).toBe('idp_error');
    idpDown = true;
    const down = await ssoLogin(ok);
    idpDown = false;
    expect(down.start.statusCode).toBe(302);
    expect(new URL(down.start.headers.location as string).searchParams.get('sso_error')).toBe(
      'idp_unreachable',
    );
    expect((await exchange('garbage-ticket-value')).status).toBe(401);
    // a forged ticket signed with another key is refused as well
    const bogus = await new SignJWT({ kind: 'sso_ticket', uid: fx.emp.jon, jti: 'z' })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode('a'.repeat(40)));
    expect((await exchange(bogus)).status).toBe(401);
    expect(
      await ctx.db.selectFrom('sso_identity').select('id').where('subject', '=', 'sub-jon').execute(),
    ).toHaveLength(0);
  });

  it('keeps ticket-like tokens out of the role selector', async () => {
    const t = (await ssoLogin({ sub: 'sub-maria', email: 'maria@emp.test', email_verified: true })).ticket!;
    const r = await call(ctx, 'POST', '/auth/select-role', t, { role: 'employee', employeeId: fx.emp.maria });
    expect(r.status).toBe(401);
  });

  it('lets administrators in only with a second factor from the IdP; super admins never', async () => {
    const plain = await ssoLogin({ sub: 'sub-admin', email: 'admin.a@test.dev', email_verified: true });
    const denied = await exchange(plain.ticket!);
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.adminNeedsMfa).toBe(true);
    const mfa = await ssoLogin({
      sub: 'sub-admin',
      email: 'admin.a@test.dev',
      email_verified: true,
      amr: ['pwd', 'mfa'],
    });
    const ok = await exchange(mfa.ticket!);
    expect(ok.status).toBe(200);
    expect(ok.body.availableRoles.map((r: any) => r.role)).toEqual(['admin']);
    const me = await call(ctx, 'GET', '/me', ok.body.accessToken);
    expect(me.body.role).toBe('admin');
    // the super admin is not part of any company: no way in
    const sa = await ssoLogin({ sub: 'sub-sa', email: 'sa@test.dev', email_verified: true, amr: ['mfa'] });
    expect(sa.back!.searchParams.get('sso_error')).toBe('no_account');
  });

  it('stops when the provider is switched off or removed', async () => {
    expect((await configure({ enabled: false })).status).toBe(200);
    const off = await ssoLogin({ sub: 'sub-maria', email: 'maria@emp.test', email_verified: true });
    expect(new URL(off.start.headers.location as string).searchParams.get('sso_error')).toBe(
      'not_configured',
    );
    expect((await configure({ enabled: true })).status).toBe(200);
    expect(
      (await call(ctx, 'DELETE', `/sso/provider?companyId=${fx.companyA}`, fx.adminB.token)).status,
    ).toBe(403);
    expect(
      (await call(ctx, 'DELETE', `/sso/provider?companyId=${fx.companyA}`, fx.adminA.token)).status,
    ).toBe(204);
    const gone = await ssoLogin({ sub: 'sub-maria', email: 'maria@emp.test', email_verified: true });
    expect(new URL(gone.start.headers.location as string).searchParams.get('sso_error')).toBe(
      'not_configured',
    );
    expect(await ctx.db.selectFrom('sso_identity').select('id').execute()).toHaveLength(0);
  });
});
