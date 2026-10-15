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
  emp = await employeeTokens(ctx, fx, ['maria', 'tom']);
});
afterAll(async () => stopApp(ctx));

const W = '2026-10-19'; // a Monday in the future
const shared = (token: string, hotels = fx.hotelA1, from = W) =>
  call(ctx, 'GET', `/schedule/shared?hotelIds=${hotels}&from=${from}`, token);

describe('shared Dienstplan copy', () => {
  it('is refused while the week has drafts and works once it is published', async () => {
    const entry = (employeeId: number, date: string) =>
      call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
        hotelId: fx.hotelA1,
        employeeId,
        shiftId: fx.early,
        date,
      });
    expect((await entry(fx.emp.maria!, '2026-10-19')).status).toBe(201);
    expect((await entry(fx.emp.jon!, '2026-10-20')).status).toBe(201);
    // an absence of two kinds: both must look the same on the copy
    await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
      employeeId: fx.emp.tom,
      from: '2026-10-21',
      to: '2026-10-21',
      type: 'annual_leave',
    });
    await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
      employeeId: fx.emp.lena,
      from: '2026-10-22',
      to: '2026-10-22',
      type: 'vocational_school',
    });
    // wishes must never appear
    await call(ctx, 'PUT', '/me/weekday-prefs', emp.tom!, { items: [{ weekday: 1, preference: 'bad' }] });

    const draft = await shared(fx.adminA.token);
    expect(draft.status).toBe(409);
    expect(draft.body.error.details.reason).toBe('NOT_PUBLISHED');

    expect(
      (
        await call(ctx, 'POST', '/schedule/publish', fx.adminA.token, {
          hotelIds: [fx.hotelA1],
          from: W,
          to: '2026-10-25',
        })
      ).status,
    ).toBe(200);

    const r = await shared(fx.adminA.token);
    expect(r.status).toBe(200);
    expect(r.body.from).toBe(W);
    const people = r.body.hotels.flatMap((h: any) => h.departments.flatMap((d: any) => d.employees));
    const names = people.map((p: any) => p.name);
    // full names, not the short display names
    expect(names).toContain('Maria Test');
    expect(names).toContain('Jon Test');
    const cell = (name: string, date: string) =>
      people.find((p: any) => p.name === name).cells.find((c: any) => c.date === date);
    expect(cell('Maria Test', W).entries).toHaveLength(1);
    expect(cell('Tom Test', '2026-10-21')).toMatchObject({ absent: true, entries: [] });
    expect(cell('Lena Test', '2026-10-22')).toMatchObject({ absent: true, entries: [] });

    // nothing but the allowed content leaves the server
    const text = JSON.stringify(r.body).toLowerCase();
    for (const word of [
      'warning',
      'draft',
      'change',
      'wish',
      'understaff',
      'annual_leave',
      'vocational',
      'sick',
      'reason',
      'personnel',
      'minor',
      'floater',
      'hours',
    ])
      expect(text, word).not.toContain(word);
  });

  it('is limited to planners of the hotel, and every copy is audited', async () => {
    expect((await shared(emp.maria!)).status).toBe(403);
    expect((await shared(fx.mgrA2.token)).status).toBe(403); // manager of another hotel
    expect((await shared(fx.mgrA1.token)).status).toBe(200);
    const logged = await ctx.db
      .selectFrom('audit_log')
      .select('id')
      .where('action', '=', 'schedule_shared_copy')
      .execute();
    expect(logged.length).toBeGreaterThanOrEqual(2);
  });
});
