import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, ctxHolder, planFixture, startApp, stopApp, type PlanFx, type TestCtx } from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-04T10:00:00Z') }); // Sunday 12:00 local
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
});
afterAll(async () => stopApp(ctx));

const D = (n: number) => new Date(Date.UTC(2026, 9, 12 + n)).toISOString().slice(0, 10); // 12 Oct 2026 is a Monday
const create = (token: string, body: Record<string, unknown>) =>
  call(ctx, 'POST', '/schedule/entries', token, { hotelId: fx.hotelA1, ...body });
const del = (token: string, id: number) => call(ctx, 'DELETE', `/schedule/entries/${id}`, token);
const codes = (r: any) => (r.body.error?.details?.violations ?? []).map((v: any) => v.code);
const put = (token: string, severities: Record<string, unknown>, query = '') =>
  call(ctx, 'PUT', `/settings/severities${query}`, token, { severities });
const get = (token: string, query = '') => call(ctx, 'GET', `/settings/severities${query}`, token);
const level = (r: any, code: string) => r.body.restrictions.find((x: any) => x.code === code).level;
const absence = (employeeId: number, date: string) =>
  call(ctx, 'POST', '/schedule/absence', fx.mgrA1.token, {
    employeeId,
    from: date,
    to: date,
    type: 'annual_leave',
  });

describe('reading and changing the settings', () => {
  it('shows the defaults with the locked restrictions to planners', async () => {
    for (const t of [fx.mgrA1.token, fx.adminA.token, fx.saToken]) {
      const r = await get(t, t === fx.saToken ? `?companyId=${fx.companyA}` : '');
      expect(r.status).toBe(200);
      expect(r.body.customised).toBe(false);
      expect(r.body.restrictions).toHaveLength(10);
      expect(level(r, 'DAILY_OVER_8H')).toBe('soft');
      expect(level(r, 'ABSENCE_CONFLICT')).toBe('hard');
      expect(level(r, 'UNAVAILABLE')).toBe('reason');
      expect(r.body.locked).toEqual(
        expect.arrayContaining(['DAILY_LIMIT', 'REST_PERIOD', 'MINOR_NIGHT', 'OVERLAP']),
      );
    }
  });

  it('only admins and the super admin change it, and only for their own company', async () => {
    expect((await put(fx.mgrA1.token, { DAILY_OVER_8H: 'hard' })).status).toBe(403);
    expect((await put(fx.adminB.token, { DAILY_OVER_8H: 'hard' }, `?companyId=${fx.companyA}`)).status).toBe(
      403,
    );
    expect((await put(fx.adminA.token, { DAILY_OVER_8H: 'hard' }, `?hotelId=${fx.hotelB1}`)).status).toBe(
      403,
    );
    const ok = await put(fx.adminA.token, { DAILY_OVER_8H: 'hard' });
    expect(ok.status).toBe(200);
    expect(ok.body.customised).toBe(true);
    expect(level(ok, 'DAILY_OVER_8H')).toBe('hard');
    expect((await put(fx.saToken, {}, `?companyId=${fx.companyA}`)).status).toBe(200);
    expect(level(await get(fx.mgrA1.token), 'DAILY_OVER_8H')).toBe('soft');
    expect((await call(ctx, 'GET', '/settings/severities', null)).status).toBe(401);
  });

  it('refuses statutory restrictions, unknown ones and levels that are not offered, and audits changes', async () => {
    for (const bad of [
      { DAILY_LIMIT: 'soft' },
      { OVERLAP: 'soft' },
      { MINOR_NIGHT: 'soft' },
      { NOPE: 'hard' },
      { REST_PERIOD_SHORT: 'soft' },
      { DAILY_OVER_8H: 'reason' },
    ]) {
      const r = await put(fx.adminA.token, bad);
      expect(r.status).toBe(400);
      expect(r.body.error.details.errors).toHaveLength(1);
    }
    expect((await put(fx.adminA.token, { DAILY_OVER_8H: 3 })).status).toBe(400);
    const before = (
      await ctx.db
        .selectFrom('audit_log')
        .select('id')
        .where('action', '=', 'rule_severities_changed')
        .execute()
    ).length;
    await put(fx.adminA.token, { MONTHLY_CAP: 'hard' });
    const rows = await ctx.db
      .selectFrom('audit_log')
      .select(['old_values', 'new_values'])
      .where('action', '=', 'rule_severities_changed')
      .orderBy('id', 'desc')
      .execute();
    expect(rows.length).toBe(before + 1);
    expect(rows[0].old_values).toMatchObject({ MONTHLY_CAP: 'soft' });
    expect(rows[0].new_values).toMatchObject({ MONTHLY_CAP: 'hard' });
    await put(fx.adminA.token, {});
  });
});

describe('planning follows the configuration', () => {
  it('a warning becomes impossible when set to hard, also with the emergency override, and plannable again when reset', async () => {
    const long = { employeeId: fx.emp.maria, date: D(0), start: '06:00', end: '16:00' }; // 9.25 h
    const warn = await create(fx.adminA.token, long);
    expect(warn.status).toBe(201);
    expect(warn.body.warnings.map((w: any) => w.code)).toEqual(['DAILY_OVER_8H']);
    await del(fx.adminA.token, warn.body.entry.id);

    expect((await put(fx.adminA.token, { DAILY_OVER_8H: 'hard' })).status).toBe(200);
    const blocked = await create(fx.adminA.token, long);
    expect(blocked.status).toBe(422);
    expect(codes(blocked)).toEqual(['DAILY_OVER_8H']);
    const tried = await create(fx.adminA.token, {
      ...long,
      emergencyOverride: true,
      overrideReason: 'Notfall bei Ausfall',
    });
    expect(tried.status).toBe(422);
    expect(codes(tried)).toEqual(['DAILY_OVER_8H']);

    await put(fx.adminA.token, {});
    const again = await create(fx.adminA.token, long);
    expect(again.status).toBe(201);
    await del(fx.adminA.token, again.body.entry.id);
  });

  it('an absence can be made a warning: the entry is planned and the warning is shown', async () => {
    await put(fx.adminA.token, {});
    expect((await absence(fx.emp.jon, D(2))).status).toBe(201);
    const body = { employeeId: fx.emp.jon, date: D(2), start: '08:00', end: '12:00' };
    const hard = await create(fx.adminA.token, body); // the default
    expect(hard.status).toBe(422);
    expect(codes(hard)).toEqual(['ABSENCE_CONFLICT']);

    await put(fx.adminA.token, { ABSENCE_CONFLICT: 'soft' });
    const soft = await create(fx.mgrA1.token, body);
    expect(soft.status).toBe(201);
    expect(soft.body.warnings.map((w: any) => w.code)).toEqual(['ABSENCE_CONFLICT']);
    await del(fx.adminA.token, soft.body.entry.id);

    await put(fx.adminA.token, { ABSENCE_CONFLICT: 'hard' });
    expect((await create(fx.adminA.token, body)).status).toBe(422);
    await put(fx.adminA.token, {});
  });

  it('statutory limits cannot be turned off through the configuration', async () => {
    await put(fx.adminA.token, { DAILY_OVER_8H: 'soft', ABSENCE_CONFLICT: 'soft' });
    const tooLong = await create(fx.adminA.token, {
      employeeId: fx.emp.maria,
      date: D(1),
      start: '06:00',
      end: '19:00',
    });
    expect(tooLong.status).toBe(422);
    expect(codes(tooLong)).toContain('DAILY_LIMIT');
    const minor = await create(fx.adminA.token, {
      employeeId: fx.emp.lena,
      date: D(1),
      start: '18:00',
      end: '21:00',
    });
    expect(codes(minor)).toContain('MINOR_NIGHT');
    await put(fx.adminA.token, {});
  });

  it('the rest period of 10 to 11 hours needs a reason by default and is impossible when set to hard', async () => {
    const first = await create(fx.adminA.token, { employeeId: fx.emp.maria, shiftId: fx.late, date: D(3) }); // ends 22:00
    expect(first.status).toBe(201);
    const next = { employeeId: fx.emp.maria, date: D(4), start: '08:00', end: '12:00' }; // 10 h of rest
    const needs = await create(fx.adminA.token, next);
    expect(needs.body.error.code).toBe('REASON_REQUIRED');
    const done = await create(fx.adminA.token, { ...next, overrideReason: 'Vertretung wegen Krankheit' });
    expect(done.status).toBe(201);
    await del(fx.adminA.token, done.body.entry.id);

    await put(fx.adminA.token, { REST_PERIOD_SHORT: 'hard' });
    const blocked = await create(fx.adminA.token, { ...next, overrideReason: 'Vertretung wegen Krankheit' });
    expect(blocked.status).toBe(422);
    expect(codes(blocked)).toEqual(['REST_PERIOD']);
    const noOverride = await create(fx.adminA.token, {
      ...next,
      emergencyOverride: true,
      overrideReason: 'Notfall bei Ausfall',
    });
    expect(noOverride.status).toBe(422);
    // below 10 hours stays a statutory block that an admin may still override in an emergency
    const statutory = await create(fx.adminA.token, {
      employeeId: fx.emp.maria,
      date: D(4),
      start: '06:00',
      end: '10:00',
      emergencyOverride: true,
      overrideReason: 'Notfall bei Ausfall',
    });
    expect(statutory.status).toBe(201);
    await del(fx.adminA.token, statutory.body.entry.id);
    await del(fx.adminA.token, first.body.entry.id);
    await put(fx.adminA.token, {});
  });

  it('a hotel can have its own choices; the others keep the company setting', async () => {
    await put(fx.adminA.token, { ABSENCE_CONFLICT: 'soft' });
    await put(fx.adminA.token, { ABSENCE_CONFLICT: 'hard' }, `?hotelId=${fx.hotelA1}`);
    expect(level(await get(fx.mgrA1.token, `?hotelId=${fx.hotelA1}`), 'ABSENCE_CONFLICT')).toBe('hard');
    expect(level(await get(fx.mgrA2.token, `?hotelId=${fx.hotelA2}`), 'ABSENCE_CONFLICT')).toBe('soft');
    expect((await absence(fx.emp.tom, D(1))).status).toBe(201);
    const a1 = await create(fx.adminA.token, {
      employeeId: fx.emp.tom,
      date: D(1),
      start: '08:00',
      end: '12:00',
    });
    expect(a1.status).toBe(422);
    const a2 = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA2,
      employeeId: fx.emp.tom,
      shiftId: fx.early2,
      date: D(1),
    });
    expect(a2.status).toBe(201);
    expect(a2.body.warnings.map((w: any) => w.code)).toEqual(['ABSENCE_CONFLICT']);
    await del(fx.adminA.token, a2.body.entry.id);
    // a manager of another hotel does not see the A1 choice
    expect((await get(fx.mgrA2.token, `?hotelId=${fx.hotelA1}`)).status).toBe(403);
  });

  it('saving the working-time limits keeps the soft/hard choices, and resetting the rules clears both', async () => {
    await put(fx.adminA.token, { MONTHLY_CAP: 'hard' });
    const limits = await call(ctx, 'PUT', '/settings/rules', fx.adminA.token, {
      limits: { dailyWarnMinutes: 420 },
    });
    expect(limits.status).toBe(200);
    expect(level(await get(fx.adminA.token), 'MONTHLY_CAP')).toBe('hard');
    expect((await call(ctx, 'GET', '/settings/rules', fx.adminA.token)).body.limits.dailyWarnMinutes).toBe(
      420,
    );
    // and the other way round: new choices keep the limits
    await put(fx.adminA.token, { MONTHLY_CAP: 'soft' });
    expect((await call(ctx, 'GET', '/settings/rules', fx.adminA.token)).body.limits.dailyWarnMinutes).toBe(
      420,
    );
    expect((await call(ctx, 'DELETE', '/settings/rules', fx.adminA.token)).status).toBe(204);
    const reset = await get(fx.adminA.token);
    expect(reset.body.customised).toBe(false);
    expect(level(reset, 'MONTHLY_CAP')).toBe('soft');
  });
});
