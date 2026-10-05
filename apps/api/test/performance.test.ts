import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { runJobsOnce, startJobs } from '../src/jobs/scheduler';
import { auth, loginAs, makeSuperAdmin, startApp, stopApp, type TestCtx } from './helpers';

let ctx: TestCtx;
let cached: FastifyInstance;
let token: string;
let userId: number;

beforeAll(async () => {
  ctx = await startApp();
  const sa = await makeSuperAdmin(ctx.db);
  userId = sa.userId;
  token = await loginAs(ctx, 'sa@test.dev', 'superAdmin');
  cached = await buildApp({
    db: ctx.db,
    logger: false,
    config: { DATABASE_URL: process.env.DATABASE_URL, PRINCIPAL_CACHE_MS: 60000 },
  });
});
afterAll(async () => {
  await cached.close();
  await stopApp(ctx);
});

describe('principal cache', () => {
  it('reuses the resolved scope inside the window, and not when the cache is off', async () => {
    const me = (app: FastifyInstance) =>
      app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(token) });
    expect((await me(cached)).statusCode).toBe(200);
    await ctx.db.updateTable('user_account').set({ status: 'blocked' }).where('id', '=', userId).execute();
    // cached app still answers (documented: a change takes effect after PRINCIPAL_CACHE_MS at most)
    expect((await me(cached)).statusCode).toBe(200);
    // the uncached app (tests) sees the change at once
    expect((await me(ctx.app)).statusCode).toBe(401);
  });
});

describe('job leader lock', () => {
  it('a second scheduler skips its tick while another process holds the lock', async () => {
    let ran = 0;
    const holder = await ctx.db.connection().execute(async (conn) => {
      await sql`select pg_advisory_lock(7003)`.execute(conn);
      // while this connection holds the lock, a tick must not run any job
      const stop = startJobs(ctx.db, () => new Date(), { error: () => (ran += 1) }, 20);
      await new Promise((r) => setTimeout(r, 120));
      stop();
      await sql`select pg_advisory_unlock(7003)`.execute(conn);
      return ran;
    });
    expect(holder).toBe(0);
  });
  it('runJobsOnce runs every job without throwing on an empty database', async () => {
    const errors: object[] = [];
    await runJobsOnce(ctx.db, () => new Date('2026-10-04T10:00:00Z'), { error: (o) => errors.push(o) });
    expect(errors).toEqual([]);
  });
});
