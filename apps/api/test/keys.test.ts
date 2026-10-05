import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { Keys } from '../src/lib/keys';
import { signAccessToken, signPayload, verifyToken } from '../src/lib/jwt';
import { call, ctxHolder, planFixture, startApp, stopApp, type PlanFx, type TestCtx } from './helpers';

const base = {
  JWT_SECRET: 'j'.repeat(40),
  JWT_SECRET_PREVIOUS: undefined as string | undefined,
  DATA_KEY: 'a1'.repeat(32),
  DATA_KEY_PREVIOUS: undefined as string | undefined,
  TOTP_ENC_KEY: undefined as string | undefined,
};
const LEGACY = '0123456789abcdef'.repeat(4);

/** What the app did before purpose keys existed: the raw key, same layout. */
function legacySeal(plain: Buffer | string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(LEGACY, 'hex'), iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

describe('purpose keys', () => {
  const keys = new Keys(base);

  it('derives a different, stable key per purpose', () => {
    const all = (['access', 'kiosk', 'sso'] as const).map((p) =>
      Buffer.from(keys.signing(p)).toString('hex'),
    );
    expect(new Set(all).size).toBe(3);
    expect(Buffer.from(keys.signing('kiosk')).toString('hex')).toBe(
      Buffer.from(new Keys(base).signing('kiosk')).toString('hex'),
    );
    expect(Buffer.from(keys.signing('access')).toString('hex')).not.toBe(
      Buffer.from(base.JWT_SECRET).toString('hex'),
    );
    const a = keys.seal('totp', 'x');
    expect(() => keys.open('documents', a)).toThrow(); // another purpose cannot open it
  });

  it('keeps signed tokens inside their purpose', async () => {
    const kiosk = await signPayload(keys.signing('kiosk'), { kind: 'empref', emp: 1 }, '5m');
    const sso = await signPayload(keys.signing('sso'), { kind: 'sso_ticket', uid: 1 }, '5m');
    const access = await signAccessToken(keys.signing('access'), { sub: 7, role: 'admin' }, '5m');
    expect(await verifyToken(keys.verifying('kiosk'), kiosk)).not.toBeNull();
    expect(await verifyToken(keys.verifying('access'), kiosk)).toBeNull();
    expect(await verifyToken(keys.verifying('access'), sso)).toBeNull();
    expect(await verifyToken(keys.verifying('kiosk'), access)).toBeNull();
    expect(await verifyToken(keys.verifying('sso'), access)).toBeNull();
    expect((await verifyToken(keys.verifying('access'), access))?.sub).toBe('7');
    // a token signed with the raw secret (how it worked before) no longer opens a session
    const raw = await signAccessToken(
      new TextEncoder().encode(base.JWT_SECRET),
      { sub: 7, role: 'admin' },
      '5m',
    );
    expect(await verifyToken(keys.verifying('access'), raw)).toBeNull();
  });

  it('seals and opens, refuses tampering and detects the key in use', () => {
    const sealed = keys.seal('documents', Buffer.from('hello'));
    expect(keys.openText('documents', sealed)).toBe('hello');
    const bad = Buffer.from(sealed);
    bad[bad.length - 1] ^= 1;
    expect(() => keys.open('documents', bad)).toThrow();
    expect(keys.openWithInfo('documents', sealed).current).toBe(true);
  });

  it('rotates: old tokens and old data keep working while the previous values are configured', async () => {
    const oldKeys = new Keys(base);
    const token = await signAccessToken(oldKeys.signing('access'), { sub: 3, role: 'manager' }, '5m');
    const blob = oldKeys.seal('totp', 'SECRET');
    const rotated = new Keys({
      ...base,
      JWT_SECRET: 'k'.repeat(40),
      JWT_SECRET_PREVIOUS: base.JWT_SECRET,
      DATA_KEY: 'b2'.repeat(32),
      DATA_KEY_PREVIOUS: base.DATA_KEY,
    });
    expect((await verifyToken(rotated.verifying('access'), token))?.sub).toBe('3');
    const opened = rotated.openWithInfo('totp', blob);
    expect(opened.plain.toString()).toBe('SECRET');
    expect(opened.current).toBe(false); // the rekey job moves it
    expect(rotated.openWithInfo('totp', rotated.seal('totp', 'x')).current).toBe(true);
    // without the previous values the old material is gone
    const noPrev = new Keys({ ...base, JWT_SECRET: 'k'.repeat(40), DATA_KEY: 'b2'.repeat(32) });
    expect(await verifyToken(noPrev.verifying('access'), token)).toBeNull();
    expect(() => noPrev.open('totp', blob)).toThrow();
  });

  it('still reads data written with the legacy raw key, and finds legacy badge hashes', () => {
    const k = new Keys({ ...base, TOTP_ENC_KEY: LEGACY });
    const old = legacySeal('legacy secret');
    const r = k.openWithInfo('totp', old);
    expect(r.plain.toString()).toBe('legacy secret');
    expect(r.current).toBe(false);
    const legacyHash = createHmac('sha256', Buffer.from(LEGACY, 'hex')).update('badge:B-OLD-1').digest('hex');
    const hashes = k.badgeHashes('B-OLD-1');
    expect(hashes[0]).not.toBe(legacyHash);
    expect(hashes).toContain(legacyHash);
    expect(new Keys(base).badgeHashes('B-OLD-1')).toHaveLength(1);
  });
});

describe('configuration', () => {
  const prod = {
    NODE_ENV: 'production',
    COOKIE_SECURE: 'true',
    JWT_SECRET: 'p'.repeat(40),
    DATA_KEY: 'ab'.repeat(32),
  };
  it('refuses development keys and equal keys in production, and works without a legacy key', () => {
    expect(() => loadConfig({ ...prod, JWT_SECRET: 'dev-only-secret-change-me-please-0123456789' })).toThrow(
      /development/,
    );
    expect(() =>
      loadConfig({ ...prod, DATA_KEY: 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f' }),
    ).toThrow(/development/);
    expect(() => loadConfig({ ...prod, TOTP_ENC_KEY: 'ab'.repeat(32) })).toThrow(/differ/);
    expect(() => loadConfig({ ...prod, JWT_SECRET: 'ab'.repeat(32) })).toThrow(/different/);
    expect(() => loadConfig({ ...prod, DATA_KEY: 'nothex' })).toThrow();
    const ok = loadConfig(prod);
    expect(ok.TOTP_ENC_KEY).toBeUndefined();
    expect(loadConfig({}).TOTP_ENC_KEY).toBe(LEGACY); // development keeps reading old databases
  });
});

describe('through the API', () => {
  let ctx: TestCtx;
  let fx: PlanFx;
  beforeAll(async () => {
    ctx = await startApp();
    ctxHolder.ctx = ctx;
    fx = await planFixture(ctx);
  });
  afterAll(async () => stopApp(ctx));

  it('does not accept tablet, SSO or old-style tokens as a session', async () => {
    const k = new Keys(loadConfig());
    const kiosk = await signPayload(
      k.signing('kiosk'),
      { kind: 'empref', sub: String(fx.adminA.userId), role: 'admin' },
      '5m',
    );
    const sso = await signPayload(
      k.signing('sso'),
      { kind: 'sso_ticket', sub: String(fx.adminA.userId), role: 'admin' },
      '5m',
    );
    const old = await signAccessToken(
      new TextEncoder().encode(loadConfig().JWT_SECRET),
      { sub: fx.adminA.userId, role: 'admin' },
      '5m',
    );
    for (const t of [kiosk, sso, old]) expect((await call(ctx, 'GET', '/me', t)).status).toBe(401);
    expect((await call(ctx, 'GET', '/me', fx.adminA.token)).status).toBe(200);
  });

  it('upgrades a legacy badge hash on first use', async () => {
    await ctx.db
      .updateTable('hotel')
      .set({ kiosk_identification: 'badge_pin' })
      .where('id', '=', fx.hotelA1)
      .execute();
    const dev = await call(ctx, 'POST', '/kiosk-devices', fx.adminA.token, {
      hotelId: fx.hotelA1,
      name: 'T',
    });
    const legacyHash = createHmac('sha256', Buffer.from(LEGACY, 'hex'))
      .update('badge:B-LEGACY-0001')
      .digest('hex');
    await ctx.db
      .updateTable('employee')
      .set({ badge_hash: legacyHash })
      .where('employee_id', '=', fx.emp.maria)
      .execute();
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/kiosk/badge',
      headers: { 'x-kiosk-token': dev.body.token },
      payload: { badge: 'B-LEGACY-0001' },
    });
    expect(r.statusCode).toBe(200);
    const row = await ctx.db
      .selectFrom('employee')
      .select('badge_hash')
      .where('employee_id', '=', fx.emp.maria)
      .executeTakeFirstOrThrow();
    expect(row.badge_hash).toBe(new Keys(loadConfig()).badgeHashes('B-LEGACY-0001')[0]);
    expect(row.badge_hash).not.toBe(legacyHash);
  });

  it('still downloads a document that was stored with the legacy key', async () => {
    const content = Buffer.from('%PDF-1.1 legacy file');
    await ctx.db
      .insertInto('employee_document')
      .values({
        employee_id: fx.emp.maria,
        doc_type: 'other',
        title: 'Alt',
        file_name: 'alt.pdf',
        mime: 'application/pdf',
        size_bytes: content.length,
        content_enc: legacySeal(content),
        uploaded_by_user_id: fx.adminA.userId,
      })
      .execute();
    const id = (await ctx.db.selectFrom('employee_document').select('id').executeTakeFirstOrThrow()).id;
    const r = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/documents/${id}/download`,
      headers: { authorization: `Bearer ${fx.adminA.token}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(content)).toBe(true);
  });
});
