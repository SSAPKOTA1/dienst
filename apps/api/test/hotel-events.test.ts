import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

let ctx: TestCtx;
let fx: PlanFx;
let emp: Record<string, string>;
beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-04T10:00:00Z') });
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  emp = await employeeTokens(ctx, fx, ['maria']);
});
afterAll(async () => stopApp(ctx));

const body = (hotelId: number, extra: Record<string, unknown> = {}) => ({
  hotelId,
  title: 'Messe Frankfurt',
  kind: 'messe',
  startDate: '2026-10-13',
  endDate: '2026-10-15',
  ...extra,
});

describe('hotel events (event calendar)', () => {
  it('creates, lists, edits and deletes an entry and writes the audit log', async () => {
    const c = await call(ctx, 'POST', '/hotel-events', fx.mgrA1.token, body(fx.hotelA1, { note: 'Stände' }));
    expect(c.status).toBe(201);
    const id = c.body.id as number;
    const q = `hotelIds=${fx.hotelA1}&from=2026-10-01&to=2026-10-31`;
    const l = await call(ctx, 'GET', `/hotel-events?${q}`, fx.adminA.token);
    expect(l.body.items).toMatchObject([{ id, title: 'Messe Frankfurt', kind: 'messe', note: 'Stände' }]);
    const u = await call(ctx, 'PUT', `/hotel-events/${id}`, fx.adminA.token, {
      title: 'Messe',
      kind: 'tagung',
      startDate: '2026-10-13',
      endDate: '2026-10-13',
    });
    expect(u.body).toMatchObject({ title: 'Messe', kind: 'tagung', endDate: '2026-10-13', note: null });
    expect((await call(ctx, 'DELETE', `/hotel-events/${id}`, fx.adminA.token)).status).toBe(204);
    expect((await call(ctx, 'GET', `/hotel-events?${q}`, fx.adminA.token)).body.items).toEqual([]);
    const log = await ctx.db
      .selectFrom('audit_log')
      .select('action')
      .where('entity_type', '=', 'hotel_event')
      .orderBy('id')
      .execute();
    expect(log.map((a) => a.action)).toEqual([
      'hotel_event_created',
      'hotel_event_updated',
      'hotel_event_deleted',
    ]);
  });

  it('rejects an end before the start and unknown kinds', async () => {
    const bad = await call(
      ctx,
      'POST',
      '/hotel-events',
      fx.adminA.token,
      body(fx.hotelA1, { endDate: '2026-10-12' }),
    );
    expect(bad.status).toBe(400);
    const kind = await call(
      ctx,
      'POST',
      '/hotel-events',
      fx.adminA.token,
      body(fx.hotelA1, { kind: 'party' }),
    );
    expect(kind.status).toBe(400);
  });

  it('keeps hotels apart: managers and admins only reach their own hotels, super admins all', async () => {
    const a1 = await call(ctx, 'POST', '/hotel-events', fx.adminA.token, body(fx.hotelA1));
    // manager of A2, admin of company B and foreign hotel ids are refused
    expect((await call(ctx, 'POST', '/hotel-events', fx.mgrA2.token, body(fx.hotelA1))).status).toBe(403);
    expect((await call(ctx, 'POST', '/hotel-events', fx.adminB.token, body(fx.hotelA1))).status).toBe(403);
    expect(
      (await call(ctx, 'PUT', `/hotel-events/${a1.body.id}`, fx.mgrA2.token, body(fx.hotelA1))).status,
    ).toBe(403);
    expect((await call(ctx, 'DELETE', `/hotel-events/${a1.body.id}`, fx.adminB.token)).status).toBe(403);
    const q = (h: number) => `hotelIds=${h}&from=2026-10-01&to=2026-10-31`;
    expect((await call(ctx, 'GET', `/hotel-events?${q(fx.hotelA1)}`, fx.mgrA2.token)).status).toBe(403);
    // without hotelIds a manager sees only the own hotels
    const own = await call(ctx, 'GET', '/hotel-events?from=2026-10-01&to=2026-10-31', fx.mgrA2.token);
    expect(own.body.items).toEqual([]);
    const sa = await call(ctx, 'POST', '/hotel-events', fx.saToken, body(fx.hotelB1, { title: 'Gruppe B' }));
    expect(sa.status).toBe(201);
    const all = await call(ctx, 'GET', '/hotel-events?from=2026-10-01&to=2026-10-31', fx.saToken);
    expect(all.body.items.map((e: { title: string }) => e.title).sort()).toEqual([
      'Gruppe B',
      'Messe Frankfurt',
    ]);
  });

  it('is closed to employees and anonymous callers', async () => {
    for (const [m, u] of [
      ['GET', '/hotel-events?from=2026-10-01&to=2026-10-31'],
      ['POST', '/hotel-events'],
      ['PUT', '/hotel-events/1'],
      ['DELETE', '/hotel-events/1'],
    ] as const) {
      expect((await call(ctx, m, u, emp.maria!, body(fx.hotelA1))).status).toBe(403);
      expect((await call(ctx, m, u, null, body(fx.hotelA1))).status).toBe(401);
    }
  });

  it('shows the entries of every day they span in the planning grid, within scope', async () => {
    await call(
      ctx,
      'POST',
      '/hotel-events',
      fx.adminA.token,
      body(fx.hotelA1, { title: 'Tagung', kind: 'tagung' }),
    );
    const g = await call(
      ctx,
      'GET',
      `/schedule/grid?hotelIds=${fx.hotelA1}&range=week&from=2026-10-12`,
      fx.mgrA1.token,
    );
    const byDate = Object.fromEntries(
      g.body.days.map((d: { date: string; events: Array<{ title: string }> }) => [
        d.date,
        d.events.map((e) => e.title),
      ]),
    );
    expect(byDate['2026-10-12']).toEqual([]);
    expect(byDate['2026-10-13']).toContain('Tagung');
    expect(byDate['2026-10-15']).toContain('Tagung');
    expect(byDate['2026-10-16']).toEqual([]);
    // the plan of another hotel does not carry them
    const other = await call(
      ctx,
      'GET',
      `/schedule/grid?hotelIds=${fx.hotelA2}&range=week&from=2026-10-12`,
      fx.mgrA2.token,
    );
    expect(other.body.days.every((d: { events: unknown[] }) => d.events.length === 0)).toBe(true);
  });
});
