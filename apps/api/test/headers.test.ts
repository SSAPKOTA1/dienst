import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db';
import { call, ctxHolder, planFixture, startApp, stopApp, type PlanFx, type TestCtx } from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
beforeAll(async () => {
  ctx = await startApp();
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
});
afterAll(async () => stopApp(ctx));

const get = (url: string, token?: string) =>
  ctx.app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('security headers', () => {
  it('sends a deny-all policy, nosniff, no framing, no referrer and a locked permissions policy', async () => {
    const r = await get('/api/v1/health');
    expect(r.headers['content-security-policy']).toBe(
      "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'",
    );
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(r.headers['permissions-policy']).toMatch(/geolocation=\(\)/);
    expect(r.headers['permissions-policy']).toMatch(/camera=\(\)/);
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers.server).toBeUndefined();
  });

  it('does not pin https outside production', async () => {
    expect((await get('/api/v1/health')).headers['strict-transport-security']).toBeUndefined();
  });

  it('sends HSTS in production', async () => {
    const db = createDb(process.env.DATABASE_URL ?? 'postgres://dienst:dienst@localhost:5432/dienst');
    const app = await buildApp({
      db,
      config: {
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        JWT_SECRET: 'p'.repeat(40),
        TOTP_ENC_KEY: 'ab'.repeat(32),
        MAIL_MODE: 'json',
      } as never,
      logger: false,
    });
    const r = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(r.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
    await app.close();
    await db.destroy();
  });

  it('keeps personal data, tokens and credentials out of shared caches', async () => {
    for (const [url, token] of [
      ['/api/v1/me', fx.adminA.token],
      ['/api/v1/employees', fx.adminA.token],
      ['/api/v1/health', undefined],
    ] as const) {
      expect((await get(url, token)).headers['cache-control']).toBe('no-store');
    }
    // errors and unknown routes too
    expect((await get('/api/v1/does-not-exist')).headers['cache-control']).toBe('no-store');
    expect((await get('/api/v1/me')).headers['cache-control']).toBe('no-store');
    const login = await call(ctx, 'POST', '/auth/login', null, { login: 'x', password: 'y' });
    expect(login.res.headers['cache-control']).toBe('no-store');
  });

  it('applies the same headers to the public API', async () => {
    const r = await get('/api/public/v1/openapi.json');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('allows only the configured web origin for cross-origin calls with credentials', async () => {
    const ok = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/me',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/me',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});
