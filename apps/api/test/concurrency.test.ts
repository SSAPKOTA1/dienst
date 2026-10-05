import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureAllowance } from '../src/services/vacation';
import { ctxHolder, planFixture, startApp, stopApp, type PlanFx, type TestCtx } from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
beforeAll(async () => {
  ctx = await startApp();
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
});
afterAll(async () => stopApp(ctx));

describe('vacation allowance creation under concurrency', () => {
  it('creates the yearly allowance once when many requests ask at the same moment', async () => {
    const year = 2031; // a year nobody has asked about yet
    const results = await Promise.all(
      Array.from({ length: 12 }, () => ensureAllowance(ctx.db, fx.emp.maria, year)),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    const rows = await ctx.db
      .selectFrom('employee_vacation_allowance')
      .select('id')
      .where('employee_id', '=', fx.emp.maria)
      .where('year', '=', year)
      .execute();
    expect(rows).toHaveLength(1);
  });
});
