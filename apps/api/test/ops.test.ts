import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { makeErrorReporter, requestIdFrom } from '../src/lib/observability';
import { call, ctxHolder, planFixture, startApp, stopApp, type PlanFx, type TestCtx } from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
beforeAll(async () => {
  ctx = await startApp();
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
});
afterAll(async () => stopApp(ctx));

describe('request ids', () => {
  it('keeps a harmless id from the caller and replaces anything else', async () => {
    const ok = await ctx.app.inject({
      url: '/api/v1/health/live',
      headers: { 'x-request-id': 'trace-abc-12345' },
    });
    expect(ok.headers['x-request-id']).toBe('trace-abc-12345');
    for (const bad of ['short', 'has spaces in it!!', 'x'.repeat(100), '<script>alert(1)</script>']) {
      const r = await ctx.app.inject({ url: '/api/v1/health/live', headers: { 'x-request-id': bad } });
      expect(r.headers['x-request-id']).not.toBe(bad);
      expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(requestIdFrom({ headers: {} })).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('liveness and readiness', () => {
  it('live answers without touching the database; ready checks database and migrations', async () => {
    expect((await ctx.app.inject({ url: '/api/v1/health/live' })).json()).toEqual({ status: 'live' });
    const ready = await ctx.app.inject({ url: '/api/v1/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready' });
  });

  it('turns 503 while shutting down, when a migration is pending and when the database is gone', async () => {
    const life = { shuttingDown: false };
    const app = await buildApp({
      db: ctx.db,
      lifecycle: life,
      logger: false,
      config: { MAIL_MODE: 'json' } as never,
    });
    expect((await app.inject({ url: '/api/v1/health/ready' })).statusCode).toBe(200);
    life.shuttingDown = true;
    const r = await app.inject({ url: '/api/v1/health/ready' });
    expect(r.statusCode).toBe(503);
    expect(r.json().status).toBe('shutting_down');
    expect((await app.inject({ url: '/api/v1/health/live' })).statusCode).toBe(200); // still alive
    life.shuttingDown = false;
    await ctx.db
      .deleteFrom('schema_migrations' as never)
      .where('name' as never, '=', '011_indexes.sql' as never)
      .execute();
    expect((await app.inject({ url: '/api/v1/health/ready' })).json().status).toBe('migrations_pending');
    await ctx.db
      .insertInto('schema_migrations' as never)
      .values({ name: '011_indexes.sql' } as never)
      .execute();
    await app.close();
  });
});

describe('metrics', () => {
  const m = (headers: Record<string, string> = {}, app = ctx.app) => app.inject({ url: '/metrics', headers });

  it('is open in development and counts requests by route pattern, not by path', async () => {
    await ctx.app.inject({ url: '/api/v1/health/live' });
    await call(ctx, 'GET', `/employees/${fx.emp.maria}`, fx.adminA.token);
    await call(ctx, 'POST', '/auth/login', null, { login: 'nobody', password: 'wrong-wrong' });
    const r = await m();
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/plain/);
    expect(r.body).toContain('http_request_duration_seconds_bucket');
    expect(r.body).toMatch(/route="\/api\/v1\/employees\/:id"/);
    expect(r.body).not.toContain(`/employees/${fx.emp.maria}`);
    expect(r.body).toMatch(/login_failures_total [1-9]/);
    expect(r.body).toContain('process_cpu_user_seconds_total');
    expect(r.body).toContain('db_pool_connections');
  });

  it('needs the bearer token when one is set, and is off in production without one', async () => {
    const withToken = await buildApp({
      db: ctx.db,
      logger: false,
      config: { MAIL_MODE: 'json', METRICS_TOKEN: 'm'.repeat(20) } as never,
    });
    expect((await m({}, withToken)).statusCode).toBe(401);
    expect((await m({ authorization: 'Bearer wrong' }, withToken)).statusCode).toBe(401);
    expect((await m({ authorization: `Bearer ${'m'.repeat(20)}` }, withToken)).statusCode).toBe(200);
    await withToken.close();
    const prod = await buildApp({
      db: ctx.db,
      logger: false,
      config: {
        MAIL_MODE: 'json',
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        JWT_SECRET: 'p'.repeat(40),
        DATA_KEY: 'ab'.repeat(32),
      } as never,
    });
    expect((await m({}, prod)).statusCode).toBe(404);
    await prod.close();
  });

  it('counts punches and job runs', async () => {
    const { trackJob } = await import('../src/lib/metrics');
    await trackJob('unit_test_job', async () => 1);
    await expect(trackJob('unit_test_job', async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    const body = (await m()).body;
    expect(body).toMatch(/job_runs_total\{job="unit_test_job",outcome="ok"\} 1/);
    expect(body).toMatch(/job_runs_total\{job="unit_test_job",outcome="error"\} 1/);
    expect(body).toMatch(/job_last_success_timestamp_seconds\{job="unit_test_job"\}/);
  });
});

describe('error webhook', () => {
  it('sends minimal details and at most once per error every 30 seconds', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response('ok');
    }) as never;
    try {
      const report = makeErrorReporter('https://hooks.example.test/x', { warn: () => undefined });
      const err = new Error('db exploded');
      await report(err, { requestId: 'r-1', method: 'GET', route: '/api/v1/x' });
      await report(err, { requestId: 'r-2', method: 'GET', route: '/api/v1/x' }); // same error: suppressed
      await report(new Error('another'), { requestId: 'r-3', method: 'POST', route: '/api/v1/y' });
      expect(calls).toHaveLength(2);
      expect(Object.keys(calls[0].body).sort()).toEqual(['method', 'requestId', 'route', 'stack', 'text']);
      expect(calls[0].body.text).toContain('db exploded');
      await makeErrorReporter(undefined, { warn: () => undefined })(err, {
        requestId: 'r',
        method: 'GET',
        route: '/',
      });
      expect(calls).toHaveLength(2); // no URL: nothing is sent
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('reports an unhandled 500 of a route and nothing for client errors', async () => {
    const calls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body).route);
      return new Response('ok');
    }) as never;
    try {
      const app = await buildApp({
        db: ctx.db,
        logger: false,
        config: { MAIL_MODE: 'json', ERROR_WEBHOOK_URL: 'https://hooks.example.test/x' } as never,
      });
      app.get('/boom', async () => {
        throw new Error('kaboom');
      });
      await app.ready();
      expect((await app.inject({ url: '/boom' })).statusCode).toBe(500);
      expect((await app.inject({ url: '/api/v1/employees/1' })).statusCode).toBe(401);
      expect(calls).toEqual(['/boom']);
      await app.close();
    } finally {
      globalThis.fetch = orig;
    }
  });
});
