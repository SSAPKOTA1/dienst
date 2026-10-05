import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit, canonical, chainKeyOf, verifyAuditChains } from '../src/lib/audit';
import { call, ctxHolder, planFixture, startApp, stopApp, type PlanFx, type TestCtx } from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
beforeAll(async () => {
  ctx = await startApp();
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
});
afterAll(async () => stopApp(ctx));

const verify = (token: string) => call(ctx, 'GET', '/audit-log/verify', token);
const adminActor = () => ({ userId: fx.adminA.userId, type: 'admin' as const });

describe('chain keys and canonical form', () => {
  it('chains per company and spreads company-less entries over 16 negative sub-chains', () => {
    expect(chainKeyOf(7, 3)).toBe(7);
    expect(chainKeyOf(null, null)).toBe(-1);
    expect(chainKeyOf(undefined, 17)).toBe(-2);
    const keys = new Set(Array.from({ length: 100 }, (_, i) => chainKeyOf(null, i)));
    expect(keys.size).toBe(16);
    expect([...keys].every((k) => k < 0 && k >= -16)).toBe(true);
  });
  it('hashes the same value the same whatever the key order', () => {
    expect(canonical({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      canonical({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
    expect(canonical({ a: undefined, b: 1 })).toBe(canonical({ b: 1 }));
    expect(canonical({ a: 1 })).not.toBe(canonical({ a: '1' }));
  });
});

describe('verification', () => {
  it('writes linked entries per company and verifies them, with values that JSONB reorders', async () => {
    await ctx.db.transaction().execute(async (trx) => {
      await audit(trx, adminActor(), {
        action: 't1',
        companyId: fx.companyA,
        hotelId: fx.hotelA1,
        new: { zeta: 1, alpha: { m: 2, b: [3, { y: 1, x: 2 }] }, name: 'Äöü' },
        old: null,
        reason: 'because',
      });
      await audit(trx, adminActor(), {
        action: 't2',
        companyId: fx.companyA,
        new: { n: 1.5, t: new Date('2026-10-01T10:00:00Z') },
      });
    });
    await audit(
      ctx.db,
      { userId: fx.adminB.userId, type: 'admin', ip: '203.0.113.5', userAgent: 'x' },
      { action: 't3', companyId: fx.companyB },
    );
    await audit(ctx.db, { userId: null, type: 'system' }, { action: 'login_failed', status: 'failed' });
    const rows = await ctx.db
      .selectFrom('audit_log')
      .select(['id', 'chain_key', 'prev_hash', 'entry_hash', 'hash_version', 'action'])
      .where('action', 'in', ['t1', 't2', 't3'])
      .orderBy('id')
      .execute();
    expect(rows.every((r) => r.hash_version === 2)).toBe(true);
    const a = rows.filter((r) => r.chain_key === fx.companyA);
    expect(a.map((r) => r.action)).toEqual(['t1', 't2']);
    expect(a[1].prev_hash).toBe(a[0].entry_hash);
    expect(rows.find((r) => r.action === 't3')!.chain_key).toBe(fx.companyB);
    const res = await verifyAuditChains(ctx.db);
    expect(res.chains.every((c) => c.ok)).toBe(true);
    expect(res.chains.map((c) => c.chainKey)).toEqual(expect.arrayContaining([fx.companyA, fx.companyB, -1]));
  });

  it('finds a changed value and a removed entry, and points at the first bad row', async () => {
    for (let i = 0; i < 4; i++)
      await audit(ctx.db, adminActor(), { action: `chain_${i}`, companyId: fx.companyA, new: { i } });
    const ids = (
      await ctx.db
        .selectFrom('audit_log')
        .select('id')
        .where('action', 'like', 'chain_%')
        .orderBy('id')
        .execute()
    ).map((r) => r.id);
    const before = await verifyAuditChains(ctx.db, [fx.companyA]);
    expect(before.chains[0].ok).toBe(true);
    // the table stays append-only for everyone else
    await expect(sql`update audit_log set reason = 'x' where id = ${ids[0]}`.execute(ctx.db)).rejects.toThrow(
      /append-only/,
    );
    await sql`alter table audit_log disable trigger audit_log_no_update`.execute(ctx.db);
    try {
      await sql`update audit_log set new_values = '{"i": 99}' where id = ${ids[1]}`.execute(ctx.db);
      const changed = await verifyAuditChains(ctx.db, [fx.companyA]);
      expect(changed.chains[0]).toMatchObject({ ok: false, brokenAt: Number(ids[1]) });
      await sql`update audit_log set new_values = '{"i": 1}' where id = ${ids[1]}`.execute(ctx.db); // restore
      expect((await verifyAuditChains(ctx.db, [fx.companyA])).chains[0].ok).toBe(true);
      await sql`delete from audit_log where id = ${ids[2]}`.execute(ctx.db);
      const removed = await verifyAuditChains(ctx.db, [fx.companyA]);
      expect(removed.chains[0]).toMatchObject({ ok: false, brokenAt: Number(ids[3]) }); // the next row no longer links
    } finally {
      await sql`alter table audit_log enable trigger audit_log_no_update`.execute(ctx.db);
      // the deleted row cannot come back: start the next tests with clean chains (TRUNCATE is not blocked by the row trigger)
      await sql`truncate audit_log`.execute(ctx.db);
    }
  });
});

describe('verification endpoint', () => {
  it('is for administrators; a company admin sees only the own company, the super admin everything', async () => {
    await audit(ctx.db, adminActor(), { action: 'scope_a', companyId: fx.companyA });
    await audit(
      ctx.db,
      { userId: fx.adminB.userId, type: 'admin' },
      { action: 'scope_b', companyId: fx.companyB },
    );
    expect((await verify(fx.mgrA1.token)).status).toBe(403);
    expect((await verify('')).status).toBe(401);
    const a = await verify(fx.adminA.token);
    expect(a.status).toBe(200);
    expect(a.body.chains.map((c: any) => c.chainKey)).toEqual([fx.companyA]);
    expect(a.body.unverifiableLegacyRows).toBeNull();
    expect(a.body.chains[0].head).toMatch(/^[0-9a-f]{64}$/);
    const sa = await verify(fx.saToken);
    expect(sa.body.chains.map((c: any) => c.chainKey)).toEqual(
      expect.arrayContaining([fx.companyA, fx.companyB]),
    );
    expect(typeof sa.body.unverifiableLegacyRows).toBe('number');
    expect(sa.body.ok).toBe(true);
  });
});

describe('concurrency', () => {
  it('keeps a single line when many writers use the plain connection at once', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        audit(ctx.db, adminActor(), { action: `burst_${i}`, companyId: fx.companyA }),
      ),
    );
    const res = await verifyAuditChains(ctx.db, [fx.companyA]);
    expect(res.chains[0].ok).toBe(true);
    const rows = await ctx.db
      .selectFrom('audit_log')
      .select('prev_hash')
      .where('action', 'like', 'burst_%')
      .execute();
    expect(new Set(rows.map((r) => r.prev_hash)).size).toBe(25); // nobody shared a predecessor
  });

  it('lets different companies write at the same time and keeps one company in line', async () => {
    let releaseA!: () => void;
    const hold = new Promise<void>((r) => (releaseA = r));
    let aWrote!: () => void;
    const aHasLock = new Promise<void>((r) => (aWrote = r));
    const txA = ctx.db.transaction().execute(async (trx) => {
      await audit(trx, adminActor(), { action: 'slow_a', companyId: fx.companyA });
      aWrote();
      await hold; // keeps company A's chain locked
    });
    await aHasLock;
    const timeout = (ms: number) => new Promise<string>((r) => setTimeout(() => r('timeout'), ms));
    // another company is not held up
    const b = await Promise.race([
      audit(
        ctx.db,
        { userId: fx.adminB.userId, type: 'admin' },
        { action: 'fast_b', companyId: fx.companyB },
      ).then(() => 'done'),
      timeout(3000),
    ]);
    expect(b).toBe('done');
    // the same company waits for the open transaction
    const a2 = Promise.race([
      audit(ctx.db, adminActor(), { action: 'queued_a', companyId: fx.companyA }).then(() => 'done'),
      timeout(600),
    ]);
    expect(await a2).toBe('timeout');
    releaseA();
    await txA;
    await audit(ctx.db, adminActor(), { action: 'after_a', companyId: fx.companyA });
    expect((await verifyAuditChains(ctx.db)).chains.every((c) => c.ok)).toBe(true);
  });
});
