import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { assertOutboundUrl, guardedLookup, isPublicIp, safeRequest } from '../src/lib/ssrf';
import { buildApp } from '../src/app';
import { call, ctxHolder, planFixture, startApp, stopApp, type PlanFx, type TestCtx } from './helpers';

describe('isPublicIp', () => {
  it('rejects private, loopback, link-local, metadata, CGNAT, multicast and documentation ranges', () => {
    for (const ip of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '127.255.255.254',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '2001:db8::1',
      '100::1',
      '2002:7f00:1::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::a00:1',
      '::ffff:169.254.169.254',
    ])
      expect(isPublicIp(ip), ip).toBe(false);
  });
  it('accepts routable addresses and rejects things that are not addresses', () => {
    for (const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '93.184.216.34',
      '172.32.0.1',
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8',
    ])
      expect(isPublicIp(ip), ip).toBe(true);
    for (const x of ['example.com', '', '999.1.1.1', 'localhost']) expect(isPublicIp(x), x).toBe(false);
  });
});

describe('assertOutboundUrl', () => {
  const strict = { allowPrivate: false };
  it('needs https, no credentials and no internal literal or name', () => {
    expect(() => assertOutboundUrl('https://idp.example.com/realm', strict)).not.toThrow();
    for (const u of [
      'http://idp.example.com',
      'ftp://idp.example.com',
      'file:///etc/passwd',
      'https://user:pw@idp.example.com',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.5:8443',
      'https://localhost/',
      'https://db.internal/',
      'https://printer.local/',
      'https://[::ffff:127.0.0.1]/',
      'not a url',
    ])
      expect(() => assertOutboundUrl(u, strict), u).toThrow();
  });
  it('allows plain http and private addresses only when the policy says so (development, tests)', () => {
    expect(() => assertOutboundUrl('http://127.0.0.1:9000', { allowPrivate: true })).not.toThrow();
    expect(() => assertOutboundUrl('https://user:pw@127.0.0.1', { allowPrivate: true })).toThrow(); // credentials never
  });
});

describe('guarded connection', () => {
  it('refuses a host name that resolves to an internal address', async () => {
    await new Promise<void>((resolve) =>
      guardedLookup({ allowPrivate: false })('localhost', { all: true }, (err) => {
        expect(err).toBeTruthy();
        resolve();
      }),
    );
    await new Promise<void>((resolve) =>
      guardedLookup({ allowPrivate: true })('localhost', { all: true }, (err, addrs) => {
        expect(err).toBeNull();
        expect((addrs as unknown[]).length).toBeGreaterThan(0);
        resolve();
      }),
    );
  });
});

describe('safeRequest', () => {
  let srv: Server;
  let base = '';
  const dev = { allowPrivate: true };
  beforeAll(async () => {
    srv = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/' });
        return res.end();
      }
      if (req.url === '/big') {
        res.writeHead(200);
        return res.end('x'.repeat(2 * 1024 * 1024));
      }
      if (req.url === '/echo') {
        let b = '';
        req.on('data', (c) => (b += c));
        return req.on('end', () => res.end(JSON.stringify({ method: req.method, body: b })));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(async () => new Promise((r) => srv.close(r)));

  it('returns status and body and can post a form', async () => {
    expect(await safeRequest(`${base}/`, dev)).toEqual({ status: 200, body: '{"ok":true}' });
    const r = await safeRequest(`${base}/echo`, dev, { method: 'POST', body: 'a=1&b=2' });
    expect(JSON.parse(r.body)).toEqual({ method: 'POST', body: 'a=1&b=2' });
  });
  it('does not follow redirects (an internal address could hide behind one)', async () => {
    await expect(safeRequest(`${base}/redirect`, dev)).rejects.toThrow(/redirect/);
  });
  it('limits the size of the answer', async () => {
    await expect(safeRequest(`${base}/big`, dev)).rejects.toThrow(/too large/);
  });
  it('does not reach a loopback server when private addresses are not allowed', async () => {
    await expect(safeRequest(`${base}/`, { allowPrivate: false })).rejects.toThrow();
  });
});

describe('configuration', () => {
  it('allows private addresses outside production only, unless set explicitly', () => {
    expect(loadConfig({}).OUTBOUND_ALLOW_PRIVATE).toBe(true);
    const prod = {
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      JWT_SECRET: 'p'.repeat(40),
      DATA_KEY: 'ab'.repeat(32),
    };
    expect(loadConfig(prod).OUTBOUND_ALLOW_PRIVATE).toBe(false);
    expect(loadConfig({ ...prod, OUTBOUND_ALLOW_PRIVATE: 'true' }).OUTBOUND_ALLOW_PRIVATE).toBe(true);
    expect(loadConfig({ OUTBOUND_ALLOW_PRIVATE: 'false' }).OUTBOUND_ALLOW_PRIVATE).toBe(false);
  });
});

describe('SSO configuration with the guard on', () => {
  let ctx: TestCtx;
  let fx: PlanFx;
  beforeAll(async () => {
    ctx = await startApp();
    ctxHolder.ctx = ctx;
    fx = await planFixture(ctx);
  });
  afterAll(async () => stopApp(ctx));

  it('refuses issuers that point at internal addresses or use http', async () => {
    const strict = await buildApp({
      db: ctx.db,
      clock: () => ctx.now.value,
      config: {
        MAIL_MODE: 'json',
        OUTBOUND_ALLOW_PRIVATE: 'false',
        RATE_LIMIT_AUTH: 100000,
        RATE_LIMIT_GLOBAL: 100000,
      } as never,
      logger: false,
    });
    for (const issuer of [
      'https://169.254.169.254/latest',
      'https://127.0.0.1:8443/realms/x',
      'https://localhost/realms/x',
      'http://idp.example.com/x',
      'https://[::1]/x',
      'https://u:p@idp.example.com/x',
      'https://10.0.0.7/x',
    ]) {
      const r = await strict.inject({
        method: 'PUT',
        url: '/api/v1/sso/provider',
        headers: { authorization: `Bearer ${fx.adminA.token}` },
        payload: { companyId: fx.companyA, issuer, clientId: 'c', clientSecret: 's' },
      });
      expect(r.statusCode, issuer).toBe(400);
    }
    expect(await ctx.db.selectFrom('sso_provider').select('id').execute()).toHaveLength(0);
    await strict.close();
    // the default test app (private addresses allowed) still validates by fetching the metadata: an address
    // that does not answer is a clean error, not a crash
    const r = await call(ctx, 'PUT', '/sso/provider', fx.adminA.token, {
      companyId: fx.companyA,
      issuer: 'http://127.0.0.1:9/x',
      clientId: 'c',
      clientSecret: 's',
    });
    expect(r.status).toBe(409);
  });
});
