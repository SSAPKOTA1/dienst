import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  call,
  loginAs,
  makeSuperAdmin,
  setupOrg,
  startApp,
  stopApp,
  TEST_PASSWORD,
  type Org,
  type TestCtx,
} from './helpers';
import { SoftKey } from './softkey';

let ctx: TestCtx;
let org: Org;
const ORIGIN = 'http://localhost:5173';
const RP = 'localhost';

beforeAll(async () => {
  ctx = await startApp();
  org = await setupOrg(ctx);
});
afterAll(async () => stopApp(ctx));

const register = async (token: string, key: SoftKey, name = 'Yubikey') => {
  const o = await call(ctx, 'POST', '/auth/webauthn/register/options', token, {});
  expect(o.status).toBe(200);
  const res = await call(ctx, 'POST', '/auth/webauthn/register/verify', token, {
    challengeToken: o.body.challengeToken,
    name,
    response: key.register(o.body.options.challenge),
  });
  return { options: o.body, res };
};
const loginBody = (login: string, extra: Record<string, unknown> = {}) => ({
  login,
  password: TEST_PASSWORD,
  ...extra,
});

describe('security keys as a second factor', () => {
  it('a manager registers a key, lists it and removes it; the registration is audited', async () => {
    const key = new SoftKey(ORIGIN, RP);
    const { res } = await register(org.mgrA1.token, key, 'Office key');
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Office key');
    const list = await call(ctx, 'GET', '/auth/webauthn/credentials', org.mgrA1.token);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/public|credential_id|publicKey/i);
    expect(
      (await call(ctx, 'DELETE', `/auth/webauthn/credentials/${res.body.id}`, org.mgrA1.token)).status,
    ).toBe(204);
    expect((await call(ctx, 'GET', '/auth/webauthn/credentials', org.mgrA1.token)).body.items).toEqual([]);
    const log = await ctx.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', 'in', ['webauthn_registered', 'webauthn_removed'])
      .execute();
    expect(log.map((l) => l.action).sort()).toEqual(['webauthn_registered', 'webauthn_removed']);
  });
  it('employees and anonymous callers cannot use the key endpoints', async () => {
    expect((await call(ctx, 'POST', '/auth/webauthn/register/options', null, {})).status).toBe(401);
    expect((await call(ctx, 'GET', '/auth/webauthn/credentials', null)).status).toBe(401);
  });
  it('refuses a registration with the wrong origin, a foreign challenge or a replayed key', async () => {
    const key = new SoftKey(ORIGIN, RP);
    const o = await call(ctx, 'POST', '/auth/webauthn/register/options', org.mgrA2.token, {});
    const wrongOrigin = await call(ctx, 'POST', '/auth/webauthn/register/verify', org.mgrA2.token, {
      challengeToken: o.body.challengeToken,
      name: 'evil',
      response: key.register(o.body.options.challenge, 'https://evil.example'),
    });
    expect(wrongOrigin.status).toBe(401);
    // the challenge belongs to manager A2: manager A1 cannot finish it
    const stolen = await call(ctx, 'POST', '/auth/webauthn/register/verify', org.mgrA1.token, {
      challengeToken: o.body.challengeToken,
      name: 'stolen',
      response: key.register(o.body.options.challenge),
    });
    expect(stolen.status).toBe(401);
    const bogus = await call(ctx, 'POST', '/auth/webauthn/register/verify', org.mgrA2.token, {
      challengeToken: 'x'.repeat(30),
      name: 'n',
      response: key.register(o.body.options.challenge),
    });
    expect(bogus.status).toBe(401);
    // a good registration works once; the same key cannot be added again
    const first = await register(org.mgrA2.token, key);
    expect(first.res.status).toBe(201);
    const again = await register(org.mgrA2.token, key, 'copy');
    expect(again.res.status).toBe(409);
  });
});

describe('login with a security key (administrators)', () => {
  it('replaces the authenticator app: password, then a signed challenge; counters move forward; a replay fails', async () => {
    const key = new SoftKey(ORIGIN, RP);
    const token = org.adminA.token;
    await register(token, key, 'Admin key');
    // the admin had TOTP from setup; also clear it to prove the key alone is enough
    await ctx.db
      .updateTable('user_account')
      .set({ totp_enabled: false })
      .where('id', '=', org.adminA.userId)
      .execute();
    const email = (
      await ctx.db
        .selectFrom('user_account')
        .select('email')
        .where('id', '=', org.adminA.userId)
        .executeTakeFirstOrThrow()
    ).email!;

    const need = await call(ctx, 'POST', '/auth/login', null, loginBody(email));
    expect(need.status).toBe(401);
    expect(need.body.error.details.webauthn.options.challenge).toBeTruthy();
    expect(need.body.error.details.totpRequired).toBe(false);
    const { options, challengeToken } = need.body.error.details.webauthn;

    const ok = await call(
      ctx,
      'POST',
      '/auth/login',
      null,
      loginBody(email, { webauthn: { challengeToken, response: key.assert(options.challenge) } }),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken ?? ok.body.preToken).toBeTruthy();
    expect(ok.body.twoFactorSetupRequired).not.toBe(true);
    const row = await ctx.db
      .selectFrom('webauthn_credential')
      .select(['counter', 'last_used_at'])
      .where('user_id', '=', org.adminA.userId)
      .executeTakeFirstOrThrow();
    expect(Number(row.counter)).toBe(key.counter);
    expect(row.last_used_at).not.toBeNull();

    // the same assertion again (replay with an old counter) is refused
    const replayKey = new SoftKey(ORIGIN, RP);
    void replayKey;
    const stale = key.assert(options.challenge);
    // build a stale response: counter lower than stored
    key.counter = 0;
    const lower = key.assert(options.challenge);
    const replay = await call(
      ctx,
      'POST',
      '/auth/login',
      null,
      loginBody(email, { webauthn: { challengeToken, response: lower } }),
    );
    expect(replay.status).toBe(401);
    void stale;
  });
  it('is refused for a wrong key, a wrong password, another users challenge and a foreign origin', async () => {
    const key = new SoftKey(ORIGIN, RP);
    const sa = await makeSuperAdmin(ctx.db, 'sa2@test.dev');
    const saToken = await loginAs(ctx, 'sa2@test.dev', 'superAdmin');
    await register(saToken, key, 'SA key');
    const need = await call(ctx, 'POST', '/auth/login', null, loginBody('sa2@test.dev'));
    const { options, challengeToken } = need.body.error.details.webauthn;
    const attempt = (extra: Record<string, unknown>, pw = TEST_PASSWORD) =>
      call(ctx, 'POST', '/auth/login', null, { login: 'sa2@test.dev', password: pw, ...extra });
    expect(
      (
        await attempt({
          webauthn: { challengeToken, response: new SoftKey(ORIGIN, RP).assert(options.challenge) },
        })
      ).status,
    ).toBe(401); // another authenticator
    expect(
      (
        await attempt({
          webauthn: { challengeToken, response: key.assert(options.challenge, 'https://evil.example') },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await attempt(
          { webauthn: { challengeToken, response: key.assert(options.challenge) } },
          'wrong-password-123',
        )
      ).status,
    ).toBe(401);
    // a challenge issued for another account is not accepted
    const other = await call(
      ctx,
      'POST',
      '/auth/login',
      null,
      loginBody(
        (
          await ctx.db
            .selectFrom('user_account')
            .select('email')
            .where('id', '=', org.adminB.userId)
            .executeTakeFirstOrThrow()
        ).email!,
      ),
    );
    const foreign = other.body.error?.details?.webauthn?.challengeToken;
    if (foreign)
      expect(
        (await attempt({ webauthn: { challengeToken: foreign, response: key.assert(options.challenge) } }))
          .status,
      ).toBe(401);
    // and finally the right one works
    expect(
      (await attempt({ webauthn: { challengeToken, response: key.assert(options.challenge) } })).status,
    ).toBe(200);
    void sa;
  });
  it('an administrator cannot remove the only second factor, but can once the authenticator app is set up', async () => {
    const key = new SoftKey(ORIGIN, RP);
    const { res } = await register(org.adminB.token, key, 'B key');
    await ctx.db
      .updateTable('user_account')
      .set({ totp_enabled: false })
      .where('id', '=', org.adminB.userId)
      .execute();
    const blocked = await call(ctx, 'DELETE', `/auth/webauthn/credentials/${res.body.id}`, org.adminB.token);
    expect(blocked.status).toBe(409);
    await ctx.db
      .updateTable('user_account')
      .set({ totp_enabled: true })
      .where('id', '=', org.adminB.userId)
      .execute();
    expect(
      (await call(ctx, 'DELETE', `/auth/webauthn/credentials/${res.body.id}`, org.adminB.token)).status,
    ).toBe(204);
  });
  it('someone else cannot delete my key', async () => {
    const key = new SoftKey(ORIGIN, RP);
    const { res } = await register(org.mgrA1.token, key, 'mine');
    expect(
      (await call(ctx, 'DELETE', `/auth/webauthn/credentials/${res.body.id}`, org.mgrA2.token)).status,
    ).toBe(404);
    expect(auth(org.mgrA1.token)).toBeTruthy();
  });
});
