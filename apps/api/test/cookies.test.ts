import cookiePlugin from '@fastify/cookie';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { readCookie, removeCookie, writeCookie } from '../src/lib/cookies';
import {
  TEST_PASSWORD,
  ctxHolder,
  employeeTokens,
  planFixture,
  startApp,
  stopApp,
  type PlanFx,
  type TestCtx,
} from './helpers';

const setCookies = (r: { headers: Record<string, unknown> }): string[] =>
  [r.headers['set-cookie']].flat().filter(Boolean) as string[];

describe('cookie helpers', () => {
  const mk = async (secure: boolean) => {
    const app = Fastify();
    await app.register(cookiePlugin);
    app.get('/set', async (_req, reply) => {
      writeCookie(reply, secure, 'tok', 'v1', { path: '/x', maxAge: 60, sameSite: 'strict' });
      return 'ok';
    });
    app.get('/read', async (req) => ({ v: readCookie(req, secure, 'tok') ?? null }));
    app.get('/clear', async (_req, reply) => {
      removeCookie(reply, secure, 'tok', '/x');
      return 'ok';
    });
    return app;
  };

  it('uses the plain name over http and the __Secure- name over https', async () => {
    const http = setCookies(await (await mk(false)).inject('/set'));
    expect(http).toHaveLength(1);
    expect(http[0]).toMatch(/^tok=v1;/);
    expect(http[0]).not.toMatch(/Secure/);
    const https = setCookies(await (await mk(true)).inject('/set'));
    expect(https[0]).toMatch(/^__Secure-tok=v1;/);
    expect(https[0]).toMatch(/; Secure/);
    expect(https[0]).toMatch(/HttpOnly/);
    expect(https[0]).toMatch(/SameSite=Strict/);
    expect(https[0]).toMatch(/Path=\/x/);
    expect(https.some((c) => /^tok=;/.test(c))).toBe(true); // a plain-named cookie from before is cleared
  });

  it('reads the new name first and accepts the old one only over https during the transition', async () => {
    const s = await mk(true);
    expect(
      (await s.inject({ url: '/read', headers: { cookie: '__Secure-tok=new; tok=old' } })).json().v,
    ).toBe('new');
    expect((await s.inject({ url: '/read', headers: { cookie: 'tok=old' } })).json().v).toBe('old');
    const dev = await mk(false);
    expect((await dev.inject({ url: '/read', headers: { cookie: '__Secure-tok=x' } })).json().v).toBeNull();
  });

  it('clears both names', async () => {
    const out = setCookies(await (await mk(true)).inject('/clear'));
    expect(out.some((c) => c.startsWith('__Secure-tok=;'))).toBe(true);
    expect(out.some((c) => c.startsWith('tok=;'))).toBe(true);
  });
});

describe('session cookie', () => {
  let ctx: TestCtx;
  let fx: PlanFx;
  beforeAll(async () => {
    ctx = await startApp();
    ctxHolder.ctx = ctx;
    fx = await planFixture(ctx);
    await employeeTokens(ctx, fx, ['maria']);
  });
  afterAll(async () => stopApp(ctx));

  const secureApp = () =>
    buildApp({
      db: ctx.db,
      clock: () => ctx.now.value,
      config: {
        MAIL_MODE: 'json',
        COOKIE_SECURE: 'true',
        RATE_LIMIT_AUTH: 100000,
        RATE_LIMIT_GLOBAL: 100000,
      } as never,
      logger: false,
    });
  const login = (app: Awaited<ReturnType<typeof secureApp>>) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'maria@emp.test', password: TEST_PASSWORD },
    });

  it('is SameSite=Strict, HttpOnly and limited to the auth path; plain name in development', async () => {
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'maria@emp.test', password: TEST_PASSWORD },
    });
    const c = setCookies(r).find((x) => x.startsWith('rt='))!;
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Strict/);
    expect(c).toMatch(/Path=\/api\/v1\/auth/);
    expect(c).not.toMatch(/; Secure/);
  });

  it('over https it is __Secure-rt with the Secure flag, refreshes, rotates and logs out', async () => {
    const app = await secureApp();
    const l = await login(app);
    expect(l.statusCode).toBe(200);
    const c = setCookies(l).find((x) => x.startsWith('__Secure-rt='))!;
    expect(c).toMatch(/; Secure/);
    expect(c).toMatch(/SameSite=Strict/);
    const value = c.split(';')[0].split('=')[1];
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `__Secure-rt=${value}` },
    });
    expect(r1.statusCode).toBe(200);
    expect(setCookies(r1).some((x) => x.startsWith('__Secure-rt='))).toBe(true);
    const next = setCookies(r1)
      .find((x) => x.startsWith('__Secure-rt=') && !x.startsWith('__Secure-rt=;'))!
      .split(';')[0]
      .split('=')[1];
    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: `__Secure-rt=${next}` },
    });
    expect(out.statusCode).toBe(204);
    expect(setCookies(out).some((x) => x.startsWith('__Secure-rt=;'))).toBe(true);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/refresh',
          headers: { cookie: `__Secure-rt=${next}` },
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });

  it('upgrades a session cookie from before the prefix on the next refresh', async () => {
    const dev = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'maria@emp.test', password: TEST_PASSWORD },
    });
    const legacy = setCookies(dev)
      .find((x) => x.startsWith('rt='))!
      .split(';')[0]
      .split('=')[1];
    const app = await secureApp();
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `rt=${legacy}` },
    });
    expect(r.statusCode).toBe(200);
    const cs = setCookies(r);
    expect(cs.some((x) => x.startsWith('__Secure-rt=') && /; Secure/.test(x))).toBe(true);
    expect(cs.some((x) => x.startsWith('rt=;'))).toBe(true); // the old one is removed
    await app.close();
  });
});
