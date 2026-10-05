import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expireSwaps } from '../src/jobs/autoCheckout';
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
const entries: Record<string, number> = {};

const plan = async (key: string, shiftId: number, date: string, label = `${key}${date}`) => {
  const r = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
    hotelId: fx.hotelA1,
    employeeId: fx.emp[key],
    shiftId,
    date,
  });
  expect(r.status).toBe(201);
  entries[label] = r.body.entry.id;
  return r.body.entry.id as number;
};
const rowOf = (id: number) =>
  ctx.db.selectFrom('schedule').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-20T10:00:00Z') });
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  emp = await employeeTokens(ctx, fx, ['maria', 'jon', 'tom', 'lena', 'piotr']);
  await plan('maria', fx.early, '2027-03-02');
  await plan('maria', fx.early, '2027-03-09');
  await plan('jon', fx.late, '2027-03-09');
  await plan('jon', fx.late, '2027-03-02');
  await plan('maria', fx.early, '2027-03-16');
  await plan('maria', fx.early, '2027-03-23');
  await plan('maria', fx.early, '2027-03-30');
  await call(ctx, 'POST', '/schedule/publish', fx.adminA.token, {
    hotelIds: [fx.hotelA1],
    from: '2027-03-01',
    to: '2027-03-31',
  });
});
afterAll(async () => stopApp(ctx));

describe('shift swaps', () => {
  it('giveaway to a named colleague: offer -> accept -> planner approves -> the entry moves', async () => {
    const q = await call(ctx, 'POST', '/me/swap-requests', emp.maria!, {
      scheduleId: entries.maria2027_03_02 ?? entries['maria2027-03-02'],
      counterpartEmployeeId: fx.emp.tom,
      reason: 'Arzttermin',
    });
    expect(q.status).toBe(201);
    expect(q.body).toMatchObject({ status: 'open', counterpartEmployeeId: fx.emp.tom });
    // only the named colleague sees and can accept it
    expect((await call(ctx, 'PUT', `/me/swap-requests/${q.body.id}/accept`, emp.jon!)).status).toBe(404);
    const toms = await call(ctx, 'GET', '/me/swap-requests', emp.tom!);
    expect(toms.body.items[0]).toMatchObject({ id: q.body.id, role: 'counterpart' });
    expect((await call(ctx, 'PUT', `/me/swap-requests/${q.body.id}/accept`, emp.tom!)).body.status).toBe(
      'accepted_by_peer',
    );
    expect(
      (
        await call(ctx, 'POST', '/me/swap-requests', emp.maria!, {
          scheduleId: entries['maria2027-03-02'],
          counterpartEmployeeId: fx.emp.jon,
        })
      ).status,
    ).toBe(409);
    const inbox = await call(ctx, 'GET', `/approvals/swaps?hotelIds=${fx.hotelA1}`, fx.mgrA1.token);
    expect(inbox.body.items[0]).toMatchObject({
      requester: 'Maria T.',
      counterpart: 'Tom T.',
      status: 'accepted_by_peer',
    });
    expect((await call(ctx, 'GET', `/approvals/swaps?hotelIds=${fx.hotelA2}`, fx.mgrA1.token)).status).toBe(
      403,
    );
    expect(
      (await call(ctx, 'PUT', `/approvals/swaps/${q.body.id}`, fx.mgrA2.token, { decision: 'approve' }))
        .status,
    ).toBe(403);
    expect(
      (await call(ctx, 'PUT', `/approvals/swaps/${q.body.id}`, emp.maria!, { decision: 'approve' })).status,
    ).toBe(403);
    const ok = await call(ctx, 'PUT', `/approvals/swaps/${q.body.id}`, fx.mgrA1.token, {
      decision: 'approve',
    });
    expect(ok.body.status).toBe('approved');
    expect((await rowOf(entries['maria2027-03-02']!)).employee_id).toBe(fx.emp.tom);
    expect(
      (await call(ctx, 'PUT', `/approvals/swaps/${q.body.id}`, fx.mgrA1.token, { decision: 'approve' }))
        .status,
    ).toBe(409);
    const notes = await ctx.db
      .selectFrom('notification')
      .select('kind')
      .where('kind', 'in', ['swap_offered', 'swap_accepted', 'swap_decision'])
      .execute();
    expect(notes.map((n) => n.kind)).toEqual(
      expect.arrayContaining(['swap_offered', 'swap_accepted', 'swap_decision']),
    );
    const acts = await ctx.db
      .selectFrom('audit_log')
      .select('action')
      .where('entity_type', '=', 'shift_swap_request')
      .execute();
    expect(acts.map((a) => a.action)).toEqual(
      expect.arrayContaining(['swap_requested', 'swap_accepted', 'swap_approved']),
    );
  });

  it('1:1 swap exchanges the two entries; rejection leaves everything as it was', async () => {
    const q = await call(ctx, 'POST', '/me/swap-requests', emp.maria!, {
      scheduleId: entries['maria2027-03-09'],
      counterpartScheduleId: entries['jon2027-03-09'],
    });
    expect(q.status).toBe(201);
    await call(ctx, 'PUT', `/me/swap-requests/${q.body.id}/accept`, emp.jon!);
    expect(
      (await call(ctx, 'PUT', `/approvals/swaps/${q.body.id}`, fx.mgrA1.token, { decision: 'approve' })).body
        .status,
    ).toBe('approved');
    expect((await rowOf(entries['maria2027-03-09']!)).employee_id).toBe(fx.emp.jon);
    expect((await rowOf(entries['jon2027-03-09']!)).employee_id).toBe(fx.emp.maria);

    const q2 = await call(ctx, 'POST', '/me/swap-requests', emp.maria!, {
      scheduleId: entries['maria2027-03-16'],
      counterpartEmployeeId: fx.emp.tom,
    });
    await call(ctx, 'PUT', `/me/swap-requests/${q2.body.id}/accept`, emp.tom!);
    const no = await call(ctx, 'PUT', `/approvals/swaps/${q2.body.id}`, fx.adminA.token, {
      decision: 'reject',
      note: 'Besetzung',
    });
    expect(no.body.status).toBe('rejected');
    expect((await rowOf(entries['maria2027-03-16']!)).employee_id).toBe(fx.emp.maria);
    // the colleague may decline an open offer, the requester may cancel
    const q3 = await call(ctx, 'POST', '/me/swap-requests', emp.maria!, {
      scheduleId: entries['maria2027-03-23'],
      counterpartEmployeeId: fx.emp.tom,
    });
    expect((await call(ctx, 'PUT', `/me/swap-requests/${q3.body.id}/decline`, emp.jon!)).status).toBe(404);
    expect((await call(ctx, 'PUT', `/me/swap-requests/${q3.body.id}/decline`, emp.tom!)).body.status).toBe(
      'rejected',
    );
    const q4 = await call(ctx, 'POST', '/me/swap-requests', emp.maria!, {
      scheduleId: entries['maria2027-03-23'],
      counterpartEmployeeId: fx.emp.jon,
    });
    expect((await call(ctx, 'DELETE', `/me/swap-requests/${q4.body.id}`, emp.tom!)).status).toBe(404);
    expect((await call(ctx, 'DELETE', `/me/swap-requests/${q4.body.id}`, emp.maria!)).body.status).toBe(
      'cancelled',
    );
  });

  it('is blocked by the rules for the receiving person and by ownership, state and notice', async () => {
    // Jon already works 14-22 on 2027-03-02: the early shift would make 16 h that day
    // only the owner may offer an entry: Maria no longer owns the 2027-03-02 shift (Tom does)
    expect(
      (
        await call(ctx, 'POST', '/me/swap-requests', emp.maria!, {
          scheduleId: entries['maria2027-03-02'],
          counterpartEmployeeId: fx.emp.jon,
        })
      ).status,
    ).toBe(404);
    const clash = await call(ctx, 'POST', '/me/swap-requests', emp.tom!, {
      scheduleId: entries['maria2027-03-02'],
      counterpartEmployeeId: fx.emp.jon,
    });
    expect(clash.status).toBe(422);
    expect(clash.body.error.code).toBe('RULE_BLOCKED');
    expect(
      (
        await call(ctx, 'POST', '/me/swap-requests', emp.maria!, {
          scheduleId: entries['maria2027-03-30'],
          counterpartEmployeeId: fx.emp.maria,
        })
      ).status,
    ).toBe(400);
    // draft entries and entries starting within 12 hours cannot be offered
    const draft = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.maria,
      shiftId: fx.early,
      date: '2027-04-06',
    });
    expect(
      (
        await call(ctx, 'POST', '/me/swap-requests', emp.maria!, {
          scheduleId: draft.body.entry.id,
          counterpartEmployeeId: fx.emp.tom,
        })
      ).status,
    ).toBe(409);
    ctx.now.value = new Date('2027-03-29T20:00:00Z'); // 8 hours before 2027-03-30 06:00 (local 07:00 CEST)
    expect(
      (
        await call(ctx, 'POST', '/me/swap-requests', emp.maria!, {
          scheduleId: entries['maria2027-03-30'],
          counterpartEmployeeId: fx.emp.tom,
        })
      ).status,
    ).toBe(409);
    ctx.now.value = new Date('2026-10-20T10:00:00Z');
  });

  it('an offer to anyone is visible only to eligible colleagues of the hotel; the company can auto-approve valid swaps', async () => {
    const q = await call(ctx, 'POST', '/me/swap-requests', emp.maria!, {
      scheduleId: entries['maria2027-03-30'],
    });
    expect(q.status).toBe(201);
    expect(q.body.counterpartEmployeeId).toBeNull();
    // housekeeping Piotr is not in the department of the shift (not eligible), Tom and Jon are
    expect(
      (await call(ctx, 'GET', '/me/swap-requests', emp.piotr!)).body.items.map((i: any) => i.id),
    ).not.toContain(q.body.id);
    expect(
      (await call(ctx, 'GET', '/me/swap-requests', emp.tom!)).body.items.map((i: any) => i.id),
    ).toContain(q.body.id);
    // the 17-year-old apprentice may not take shifts that violate minor rules; the early shift is fine, so she sees it
    await ctx.db
      .updateTable('company')
      .set({ swap_approval: 'auto_if_valid' })
      .where('id', '=', fx.companyA)
      .execute();
    const acc = await call(ctx, 'PUT', `/me/swap-requests/${q.body.id}/accept`, emp.tom!);
    expect(acc.body.status).toBe('approved');
    expect((await rowOf(entries['maria2027-03-30']!)).employee_id).toBe(fx.emp.tom);
    expect((await call(ctx, 'PUT', `/me/swap-requests/${q.body.id}/accept`, emp.jon!)).status).toBe(409);
    await ctx.db
      .updateTable('company')
      .set({ swap_approval: 'manual' })
      .where('id', '=', fx.companyA)
      .execute();
  });

  it('requests expire and can be switched off per company', async () => {
    const mine = await plan('tom', fx.early, '2027-05-04');
    await call(ctx, 'POST', '/schedule/publish', fx.adminA.token, {
      hotelIds: [fx.hotelA1],
      from: '2027-05-01',
      to: '2027-05-31',
    });
    const q = await call(ctx, 'POST', '/me/swap-requests', emp.tom!, { scheduleId: mine });
    expect(q.status).toBe(201);
    ctx.now.value = new Date('2026-10-23T10:00:00Z'); // more than 48 h later
    expect(await expireSwaps(ctx.db, ctx.now.value)).toBe(1);
    expect((await call(ctx, 'PUT', `/me/swap-requests/${q.body.id}/accept`, emp.jon!)).status).toBe(409);
    expect(
      (await ctx.db.selectFrom('notification').select('kind').where('kind', '=', 'swap_expired').execute())
        .length,
    ).toBe(1);
    ctx.now.value = new Date('2026-10-20T10:00:00Z');
    await call(ctx, 'PUT', `/settings/features?companyId=${fx.companyA}`, fx.adminA.token, {
      feature: 'swaps',
      enabled: false,
    });
    const off = await call(ctx, 'GET', '/me/swap-requests', emp.tom!);
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('FEATURE_DISABLED');
    await call(ctx, 'PUT', `/settings/features?companyId=${fx.companyA}`, fx.adminA.token, {
      feature: 'swaps',
      enabled: true,
    });
  });
});

describe('open shifts', () => {
  let openId: number;
  it('planners publish an open slot, eligible employees apply, one application is approved and creates the entry', async () => {
    const o = await call(ctx, 'POST', '/open-shifts', fx.mgrA1.token, {
      hotelId: fx.hotelA1,
      departmentId: fx.deptA1,
      shiftId: fx.late,
      date: '2027-06-08',
    });
    expect(o.status).toBe(201);
    openId = o.body.id;
    expect(
      (
        await call(ctx, 'POST', '/open-shifts', fx.mgrA2.token, {
          hotelId: fx.hotelA1,
          departmentId: fx.deptA1,
          shiftId: fx.late,
          date: '2027-06-08',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'POST', '/open-shifts', fx.mgrA1.token, {
          hotelId: fx.hotelA1,
          departmentId: fx.deptA1b,
          shiftId: fx.late,
          date: '2027-06-08',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(ctx, 'POST', '/open-shifts', fx.mgrA1.token, {
          hotelId: fx.hotelA1,
          departmentId: fx.deptA1,
          date: '2027-06-08',
        })
      ).status,
    ).toBe(400);
    // housekeeping Piotr sees nothing; Maria and Jon see the slot
    expect((await call(ctx, 'GET', '/me/open-shifts', emp.piotr!)).body.items).toEqual([]);
    const seen = await call(ctx, 'GET', '/me/open-shifts', emp.maria!);
    expect(seen.body.items[0]).toMatchObject({ id: openId, shiftName: 'Spät', claim: null });
    expect((await call(ctx, 'POST', `/me/open-shifts/${openId}/claim`, emp.piotr!)).status).toBe(404);
    expect((await call(ctx, 'POST', `/me/open-shifts/${openId}/claim`, emp.maria!)).status).toBe(201);
    expect((await call(ctx, 'POST', `/me/open-shifts/${openId}/claim`, emp.maria!)).status).toBe(409);
    expect((await call(ctx, 'POST', `/me/open-shifts/${openId}/claim`, emp.jon!)).status).toBe(201);
    const list = await call(ctx, 'GET', `/open-shifts?hotelIds=${fx.hotelA1}`, fx.mgrA1.token);
    expect(list.body.items[0].claims.map((c: any) => c.displayName).sort()).toEqual(['Jon T.', 'Maria T.']);
    const claim = list.body.items[0].claims.find((c: any) => c.displayName === 'Jon T.');
    expect(
      (await call(ctx, 'PUT', `/open-shifts/claims/${claim.id}`, fx.mgrA2.token, { decision: 'approve' }))
        .status,
    ).toBe(403);
    const ok = await call(ctx, 'PUT', `/open-shifts/claims/${claim.id}`, fx.mgrA1.token, {
      decision: 'approve',
    });
    expect(ok.body.status).toBe('approved');
    const e = await rowOf(ok.body.scheduleId);
    expect(e).toMatchObject({ employee_id: fx.emp.jon, shift_date: '2027-06-08', hotel_id: fx.hotelA1 });
    expect((await call(ctx, 'GET', '/me/open-shifts', emp.maria!)).body.items).toEqual([]);
    const other = await ctx.db
      .selectFrom('open_shift_claim')
      .select('status')
      .where('employee_id', '=', fx.emp.maria!)
      .executeTakeFirstOrThrow();
    expect(other.status).toBe('rejected');
    expect(
      (await call(ctx, 'PUT', `/open-shifts/claims/${claim.id}`, fx.mgrA1.token, { decision: 'approve' }))
        .status,
    ).toBe(409);
    expect((await call(ctx, 'DELETE', `/open-shifts/${openId}`, fx.mgrA1.token)).status).toBe(409);
  });

  it('hides and refuses slots the person may not work; planners can cancel and applicants withdraw', async () => {
    // Tom works 14-22 the day before: a 06:00 slot next morning violates the rest period (block)
    await plan('tom', fx.late, '2027-06-14');
    const o = await call(ctx, 'POST', '/open-shifts', fx.mgrA1.token, {
      hotelId: fx.hotelA1,
      departmentId: fx.deptA1,
      shiftId: fx.early,
      date: '2027-06-15',
    });
    expect(
      (await call(ctx, 'GET', '/me/open-shifts', emp.tom!)).body.items.map((i: any) => i.id),
    ).not.toContain(o.body.id);
    const refused = await call(ctx, 'POST', `/me/open-shifts/${o.body.id}/claim`, emp.tom!);
    expect(refused.status).toBe(422);
    expect(refused.body.error.details.violations[0].code).toBe('REST_PERIOD');
    const c = await call(ctx, 'POST', `/me/open-shifts/${o.body.id}/claim`, emp.maria!);
    expect(c.status).toBe(201);
    expect((await call(ctx, 'DELETE', `/me/open-shifts/${o.body.id}/claim`, emp.maria!)).body.status).toBe(
      'withdrawn',
    );
    expect((await call(ctx, 'DELETE', `/me/open-shifts/${o.body.id}/claim`, emp.maria!)).status).toBe(404);
    expect((await call(ctx, 'POST', `/me/open-shifts/${o.body.id}/claim`, emp.maria!)).status).toBe(201); // may apply again
    expect((await call(ctx, 'DELETE', `/open-shifts/${o.body.id}`, fx.mgrA1.token)).body.status).toBe(
      'cancelled',
    );
    expect(
      (await call(ctx, 'GET', `/open-shifts?hotelIds=${fx.hotelA1}&status=cancelled`, fx.mgrA1.token)).body
        .items,
    ).toHaveLength(1);
  });
});

describe('colleague lookups for the swap dialog', () => {
  it('list colleagues of my hotels and their upcoming published shifts only', async () => {
    const c = await call(ctx, 'GET', '/me/colleagues', emp.maria!);
    expect(c.body.items.map((x: any) => x.displayName)).toEqual(expect.arrayContaining(['Jon T.', 'Tom T.']));
    expect(c.body.items.map((x: any) => x.displayName)).not.toContain('Maria T.');
    const s = await call(ctx, 'GET', `/me/colleagues/${fx.emp.jon}/shifts`, emp.maria!);
    expect(s.body.items.length).toBeGreaterThan(0);
    expect(s.body.items[0]).toHaveProperty('shiftName');
    // a colleague of another company is not reachable
    const other = await ctx.db
      .selectFrom('employee')
      .select('employee_id')
      .where('company_id', '=', fx.companyB)
      .executeTakeFirst();
    if (other)
      expect((await call(ctx, 'GET', `/me/colleagues/${other.employee_id}/shifts`, emp.maria!)).status).toBe(
        404,
      );
  });
});
