import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { startApp, stopApp, type TestCtx } from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await startApp();
});
afterAll(async () => stopApp(ctx));

describe('HTTP hardening', () => {
  it('sets security headers and does not announce the framework', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBeTruthy();
    expect(r.headers['strict-transport-security']).toBeTruthy();
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('answers CORS only for the configured web origin', async () => {
    const ok = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/me',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/me',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    // a single configured origin: the header never names the foreign origin, so browsers block it
    expect(bad.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  it('errors never leak stack traces', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toMatchObject({ code: 'NOT_FOUND' });
    expect(r.body).not.toMatch(/\bat \w+.*\(/);
  });
});

describe('rate limits and configuration', () => {
  it('limits login attempts per client and every other route globally; /health is exempt', async () => {
    const lim = await startApp({ rateLimit: 5 });
    try {
      const login = () =>
        lim.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { login: 'nobody@x.test', password: 'wrong-password-1' },
        });
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await login()).statusCode);
      expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
      expect(codes[6]).toBe(429);
      expect((await login()).json().error.code).toBe('RATE_LIMITED');
      // global limit on a normal route
      const other: number[] = [];
      for (let i = 0; i < 8; i++)
        other.push((await lim.app.inject({ method: 'GET', url: '/api/v1/me' })).statusCode);
      expect(other).toContain(429);
      for (let i = 0; i < 10; i++)
        expect((await lim.app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
    } finally {
      await stopApp(lim);
    }
  });

  it('refuses development secrets in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/development/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        JWT_SECRET: 'x'.repeat(40),
        TOTP_ENC_KEY: 'ab'.repeat(32),
        COOKIE_SECURE: 'false',
      } as NodeJS.ProcessEnv),
    ).toThrow(/COOKIE_SECURE/);
    expect(
      loadConfig({
        NODE_ENV: 'production',
        JWT_SECRET: 'x'.repeat(40),
        TOTP_ENC_KEY: 'ab'.repeat(32),
        COOKIE_SECURE: 'true',
      } as NodeJS.ProcessEnv).NODE_ENV,
    ).toBe('production');
  });
});
