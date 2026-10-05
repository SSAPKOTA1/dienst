import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, ctxHolder, planFixture, startApp, stopApp, type PlanFx, type TestCtx } from './helpers';

let ctx: TestCtx;
let fx: PlanFx;

beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-04T10:00:00Z') });
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
});
afterAll(async () => stopApp(ctx));

const T = () => fx.adminA.token;

describe('occupancy staffing', () => {
  it('imports a forecast (upsert), validates it and keeps hotels apart', async () => {
    const put = await call(ctx, 'PUT', '/occupancy', T(), {
      hotelId: fx.hotelA1,
      items: [
        { date: '2026-10-12', occupancyPct: 90 },
        { date: '2026-10-13', occupancyPct: 55 },
        { date: '2026-10-14', occupancyPct: 20 },
      ],
    });
    expect(put.body).toEqual({ saved: 3 });
    await call(ctx, 'PUT', '/occupancy', T(), {
      hotelId: fx.hotelA1,
      items: [{ date: '2026-10-14', occupancyPct: 25 }],
    });
    const get = await call(ctx, 'GET', `/occupancy?hotelId=${fx.hotelA1}&from=2026-10-12&to=2026-10-18`, T());
    expect(get.body.items).toEqual([
      { date: '2026-10-12', occupancyPct: 90 },
      { date: '2026-10-13', occupancyPct: 55 },
      { date: '2026-10-14', occupancyPct: 25 },
    ]);
    expect(
      (
        await call(ctx, 'PUT', '/occupancy', T(), {
          hotelId: fx.hotelA1,
          items: [{ date: '2026-10-12', occupancyPct: 101 }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(ctx, 'PUT', '/occupancy', T(), {
          hotelId: fx.hotelB1,
          items: [{ date: '2026-10-12', occupancyPct: 50 }],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'PUT', '/occupancy', fx.mgrA2.token, {
          hotelId: fx.hotelA1,
          items: [{ date: '2026-10-12', occupancyPct: 50 }],
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(ctx, 'GET', `/occupancy?hotelId=${fx.hotelA1}&from=2026-10-12&to=2024-01-01`, T())).status,
    ).toBe(400);
  });

  it('manages rules per shift and refuses a shift of another hotel', async () => {
    const mk = (shiftId: number, minOccupancyPct: number, headcount: number, token = T()) =>
      call(ctx, 'POST', '/staffing-rules', token, {
        hotelId: fx.hotelA1,
        shiftId,
        minOccupancyPct,
        headcount,
      });
    expect((await mk(fx.early, 0, 1)).status).toBe(201);
    expect((await mk(fx.early, 50, 2)).status).toBe(201);
    expect((await mk(fx.early, 80, 4)).status).toBe(201);
    expect((await mk(fx.early, 80, 5)).body.headcount).toBe(5); // same threshold: replaced
    expect((await mk(fx.early2, 10, 1)).status).toBe(400); // shift of hotel A2
    expect((await mk(fx.early, 10, 1, fx.mgrA2.token)).status).toBe(403);
    const list = await call(ctx, 'GET', `/staffing-rules?hotelId=${fx.hotelA1}`, T());
    expect(list.body.items.map((x: any) => [x.minOccupancyPct, x.headcount])).toEqual([
      [0, 1],
      [50, 2],
      [80, 5],
    ]);
    const extra = await mk(fx.early, 95, 9);
    expect((await call(ctx, 'DELETE', `/staffing-rules/${extra.body.id}`, fx.mgrA2.token)).status).toBe(403);
    expect((await call(ctx, 'DELETE', `/staffing-rules/${extra.body.id}`, T())).status).toBe(204);
  });

  it('suggests, never changes the plan, and applies only on request as date overrides', async () => {
    await call(ctx, 'PUT', `/shifts/${fx.early}/staffing`, T(), {
      weekdayDefaults: { '1': 2 },
      overrides: [],
    });
    await call(ctx, 'POST', '/schedule/entries', T(), {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.maria,
      shiftId: fx.early,
      date: '2026-10-12',
    });
    const q = `hotelId=${fx.hotelA1}&from=2026-10-12&to=2026-10-14`;
    const sug = await call(ctx, 'GET', `/staffing/suggestions?${q}`, T());
    expect(sug.status).toBe(200);
    expect(sug.body.items).toMatchObject([
      {
        date: '2026-10-12',
        shiftId: fx.early,
        occupancyPct: 90,
        suggested: 5,
        required: 2,
        planned: 1,
        deltaToRequired: 3,
        gap: 4,
      },
      { date: '2026-10-13', suggested: 2, required: 0, planned: 0 },
      { date: '2026-10-14', suggested: 1 },
    ]);
    const entries = await ctx.db.selectFrom('schedule').select('id').execute();
    expect(entries).toHaveLength(1); // suggestions do not create shifts
    const apply = await call(ctx, 'POST', '/staffing/apply', T(), {
      hotelId: fx.hotelA1,
      items: [{ shiftId: fx.early, date: '2026-10-12', headcount: 5 }],
    });
    expect(apply.body).toEqual({ applied: 1 });
    const st = await call(ctx, 'GET', `/shifts/${fx.early}/staffing`, T());
    expect(JSON.stringify(st.body)).toContain('"2026-10-12"');
    const after = await call(ctx, 'GET', `/staffing/suggestions?${q}`, T());
    expect(after.body.items[0]).toMatchObject({ required: 5, deltaToRequired: 0 });
    expect(await ctx.db.selectFrom('schedule').select('id').execute()).toHaveLength(1);
    const bad = await call(ctx, 'POST', '/staffing/apply', T(), {
      hotelId: fx.hotelA1,
      items: [{ shiftId: fx.early2, date: '2026-10-12', headcount: 1 }],
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await call(ctx, 'POST', '/staffing/apply', fx.mgrA2.token, {
          hotelId: fx.hotelA1,
          items: [{ shiftId: fx.early, date: '2026-10-12', headcount: 1 }],
        })
      ).status,
    ).toBe(403);
    const log = await ctx.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', 'in', ['occupancy_imported', 'staffing_rule_saved', 'staffing_suggestions_applied'])
      .execute();
    expect(new Set(log.map((l) => l.action)).size).toBe(3);
  });
});
