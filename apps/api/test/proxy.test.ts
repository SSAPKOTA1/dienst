import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { parseTrustProxy } from '../src/lib/proxy';
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

describe('parseTrustProxy', () => {
  it('trusts nothing by default and understands hop counts and address lists', () => {
    expect(parseTrustProxy(undefined, true)).toBe(false);
    expect(parseTrustProxy('false', true)).toBe(false);
    expect(parseTrustProxy('0', true)).toBe(false);
    expect(parseTrustProxy('1', true)).toBe(1);
    expect(parseTrustProxy('2', false)).toBe(2);
    expect(parseTrustProxy('10.0.0.0/8, 192.168.1.5,::1', true)).toEqual([
      '10.0.0.0/8',
      '192.168.1.5',
      '::1',
    ]);
  });
  it('refuses "true" in production and malformed values everywhere', () => {
    expect(parseTrustProxy('true', false)).toBe(true);
    expect(() => parseTrustProxy('true', true)).toThrow(/forge/);
    expect(() => parseTrustProxy('9', true)).toThrow(/hops/);
    expect(() => parseTrustProxy('10.0.0.0/40', true)).toThrow();
    expect(() => parseTrustProxy('not-an-ip', true)).toThrow();
    expect(() => parseTrustProxy('10.0.0.1,,evil', true)).toThrow();
  });
  it('is applied by the configuration', () => {
    expect(loadConfig({}).TRUST_PROXY).toBe(false);
    expect(loadConfig({ TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    const prod = {
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      JWT_SECRET: 'p'.repeat(40),
      DATA_KEY: 'ab'.repeat(32),
    };
    expect(() => loadConfig({ ...prod, TRUST_PROXY: 'true' })).toThrow();
    expect(loadConfig({ ...prod, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
  });
});

describe('client address with and without a proxy (web punch network check)', () => {
  let ctx: TestCtx;
  let fx: PlanFx;
  let token: string;
  beforeAll(async () => {
    ctx = await startApp();
    ctxHolder.ctx = ctx;
    fx = await planFixture(ctx);
    token = (await employeeTokens(ctx, fx, ['maria'])).maria;
    await call(ctx, 'PUT', `/hotels/${fx.hotelA1}/settings`, fx.adminA.token, {
      allowWebPunch: true,
      webPunchAllowedCidrs: ['10.0.0.0/8'],
    });
  });
  afterAll(async () => stopApp(ctx));

  /** networkOk as the app sees the request: the peer address and what a client or proxy put into X-Forwarded-For */
  async function networkOk(trust: string, peer: string, xff?: string): Promise<boolean> {
    const app = await buildApp({
      db: ctx.db,
      clock: () => ctx.now.value,
      config: {
        MAIL_MODE: 'json',
        TRUST_PROXY: trust,
        RATE_LIMIT_GLOBAL: 100000,
        RATE_LIMIT_AUTH: 100000,
      } as never,
      logger: false,
    });
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/me/punch',
      remoteAddress: peer,
      headers: { authorization: `Bearer ${token}`, ...(xff ? { 'x-forwarded-for': xff } : {}) },
    });
    await app.close();
    expect(r.statusCode).toBe(200);
    return r.json().hotels[0].networkOk as boolean;
  }

  it('with no trusted proxy a forged header changes nothing', async () => {
    expect(await networkOk('false', '10.1.2.3')).toBe(true); // really in the hotel network
    expect(await networkOk('false', '203.0.113.9', '10.1.2.3')).toBe(false); // claims to be, is not
    expect(await networkOk('false', '203.0.113.9')).toBe(false);
  });

  it('behind one proxy the address the proxy saw counts, and a prepended forgery does not', async () => {
    // the proxy (192.168.0.5) appends the address it saw as the last entry
    expect(await networkOk('1', '192.168.0.5', '10.2.3.4')).toBe(true);
    expect(await networkOk('1', '192.168.0.5', '203.0.113.9')).toBe(false);
    expect(await networkOk('1', '192.168.0.5', '10.9.9.9, 203.0.113.9')).toBe(false); // client forged the first entry
    expect(await networkOk('1', '192.168.0.5', '203.0.113.9, 10.9.9.9')).toBe(true); // last entry is what the proxy saw
  });

  it('with a proxy address list only those peers are believed', async () => {
    expect(await networkOk('192.168.0.0/16', '192.168.0.5', '10.2.3.4')).toBe(true);
    expect(await networkOk('192.168.0.0/16', '192.168.0.5', '10.9.9.9, 203.0.113.9')).toBe(false);
    // a direct client that is not a trusted proxy cannot make its header count
    expect(await networkOk('192.168.0.0/16', '203.0.113.9', '10.1.2.3')).toBe(false);
  });

  it('writes the client address into the audit entry of a web punch', async () => {
    const app = await buildApp({
      db: ctx.db,
      clock: () => ctx.now.value,
      config: { MAIL_MODE: 'json', TRUST_PROXY: '1', RATE_LIMIT_GLOBAL: 100000 } as never,
      logger: false,
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/me/punch/in',
      remoteAddress: '192.168.0.5',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '10.4.4.4' },
      payload: { hotelId: fx.hotelA1 },
    });
    await app.close();
    expect(r.statusCode).toBe(200);
    const a = await ctx.db
      .selectFrom('audit_log')
      .select('new_values')
      .where('action', '=', 'punch_in')
      .executeTakeFirstOrThrow();
    expect((a.new_values as { ip?: string }).ip).toBe('10.4.4.4');
  });
});
