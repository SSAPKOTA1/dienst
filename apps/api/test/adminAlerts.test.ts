import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAdminAlerts } from '../src/services/adminAlerts';
import {
  call,
  ctxHolder,
  employeeTokens,
  enableTotp,
  loginAs,
  makeUser,
  planFixture,
  startApp,
  stopApp,
  type PlanFx,
  type TestCtx,
} from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
let emp: Record<string, string>;
let hotelAdminA2: string; // admin limited to hotel A2 through admin_hotel

const NOW = '2026-10-20T10:00:00Z';
const D = '2026-10-20';

async function sched(key: string, start: string, end: string) {
  return (
    await ctx.db
      .insertInto('schedule')
      .values({
        hotel_id: fx.hotelA1,
        employee_id: fx.emp[key]!,
        shift_date: D,
        planned_start: new Date(start),
        planned_end: new Date(end),
        status: 'published',
        created_by_user_id: fx.adminA.userId,
        created_by_role: 'admin',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
}

async function punch(
  key: string,
  scheduleId: number | null,
  inAt: string,
  planned: [string, string],
  out?: string,
) {
  return (
    await ctx.db
      .insertInto('punch_record')
      .values({
        employee_id: fx.emp[key]!,
        hotel_id: fx.hotelA1,
        schedule_id: scheduleId,
        shift_date: D,
        source: 'kiosk',
        planned_start: new Date(planned[0]),
        planned_end: new Date(planned[1]),
        actual_punch_in: new Date(inAt),
        actual_punch_out: out ? new Date(out) : null,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
}

const bar = (token: string, q = '') => call(ctx, 'GET', `/admin-alerts${q}`, token);
const kinds = (b: any) => b.items.map((i: any) => i.kind).sort();

beforeAll(async () => {
  ctx = await startApp({ now: new Date(NOW) });
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  emp = await employeeTokens(ctx, fx, ['maria', 'jon', 'tom']);
  const userId = await makeUser(ctx.db, { email: 'hotel.a2@test.dev' });
  await enableTotp(ctx.db, userId);
  const a = await ctx.db
    .insertInto('admin')
    .values({ user_id: userId, first_name: 'Hotel', last_name: 'Admin', created_by_id: fx.superAdminId })
    .returning('admin_id')
    .executeTakeFirstOrThrow();
  await ctx.db
    .insertInto('admin_hotel')
    .values({ admin_id: a.admin_id, hotel_id: fx.hotelA2, assigned_by_id: fx.superAdminId })
    .execute();
  hotelAdminA2 = await loginAs(ctx, 'hotel.a2@test.dev', 'admin');
});
afterAll(async () => stopApp(ctx));

describe('attendance alerts', () => {
  it('reports late check-in, missed check-in and missed check-out, and nothing for the others', async () => {
    // maria: published 08:00-16:00, nobody punched, 120 min later -> missed check-in
    await sched('maria', '2026-10-20T08:00:00Z', '2026-10-20T16:00:00Z');
    // jon: clocked in 12 minutes late -> late check-in (threshold 10)
    const sj = await sched('jon', '2026-10-20T08:00:00Z', '2026-10-20T16:00:00Z');
    const pj = await punch('jon', sj, '2026-10-20T08:12:00Z', [
      '2026-10-20T08:00:00Z',
      '2026-10-20T16:00:00Z',
    ]);
    // tom: still clocked in 60 min after the planned end -> missed check-out
    const st = await sched('tom', '2026-10-20T06:00:00Z', '2026-10-20T09:00:00Z');
    const pt = await punch('tom', st, '2026-10-20T06:00:00Z', [
      '2026-10-20T06:00:00Z',
      '2026-10-20T09:00:00Z',
    ]);
    // piotr: 5 minutes late is on time; lena: absent but on approved leave -> no alert
    const sp = await sched('piotr', '2026-10-20T08:00:00Z', '2026-10-20T16:00:00Z');
    await punch('piotr', sp, '2026-10-20T08:05:00Z', ['2026-10-20T08:00:00Z', '2026-10-20T16:00:00Z']);
    await sched('lena', '2026-10-20T08:00:00Z', '2026-10-20T16:00:00Z');
    await ctx.db
      .insertInto('time_off')
      .values({
        employee_id: fx.emp.lena!,
        start_date: D,
        end_date: D,
        time_off_days: 1,
        type: 'annual_leave',
        status: 'approved',
        counts_against_allowance: true,
        credits_hours: true,
        created_by_user_id: fx.adminA.userId,
      } as never)
      .execute();

    expect(await runAdminAlerts(ctx.db, ctx.now.value)).toBe(3 * 2); // three alerts for the admin and the super admin
    const a = await bar(fx.adminA.token);
    expect(a.status).toBe(200);
    expect(kinds(a.body)).toEqual(['late_checkin', 'missed_checkin', 'missed_checkout']);
    expect(a.body.unread).toBe(3);
    const by = (k: string) => a.body.items.find((i: any) => i.kind === k);
    expect(by('late_checkin')).toMatchObject({
      employeeName: 'Jon T.',
      minutes: 12,
      refId: pj,
      hotelId: fx.hotelA1,
      open: true,
    });
    expect(by('missed_checkin')).toMatchObject({ employeeName: 'Maria T.', date: D, open: true });
    expect(by('missed_checkout')).toMatchObject({ employeeName: 'Tom T.', refId: pt, open: true });

    // run again: nothing new, even for read alerts
    expect(await runAdminAlerts(ctx.db, ctx.now.value)).toBe(0);
    expect(kinds((await bar(fx.saToken)).body)).toEqual([
      'late_checkin',
      'missed_checkin',
      'missed_checkout',
    ]);

    // clocking out in the meantime closes the missed check-out item
    await ctx.db
      .updateTable('punch_record')
      .set({ actual_punch_out: new Date('2026-10-20T09:20:00Z') })
      .where('id', '=', pt)
      .execute();
    const after = await bar(fx.adminA.token);
    expect(after.body.items.find((i: any) => i.kind === 'missed_checkout').open).toBe(false);
  });

  it('uses the thresholds of the company', async () => {
    await ctx.db
      .updateTable('company')
      .set({ alert_late_checkin_minutes: 30, alert_missed_checkin_minutes: 240 })
      .where('id', '=', fx.companyA)
      .execute();
    const s = await ctx.db
      .insertInto('schedule')
      .values({
        hotel_id: fx.hotelA1,
        employee_id: fx.emp.cap!,
        shift_date: D,
        planned_start: new Date('2026-10-20T07:00:00Z'),
        planned_end: new Date('2026-10-20T09:30:00Z'),
        status: 'published',
        created_by_user_id: fx.adminA.userId,
        created_by_role: 'admin',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await punch(
      'cap',
      s.id,
      '2026-10-20T07:20:00Z',
      ['2026-10-20T07:00:00Z', '2026-10-20T09:30:00Z'],
      '2026-10-20T09:30:00Z',
    );
    expect(await runAdminAlerts(ctx.db, ctx.now.value)).toBe(0); // 20 min late is fine with 30; 3 h absent with 4 h
  });

  it('lets only the super admin change the thresholds, within bounds', async () => {
    const put = (token: string, body: unknown) => call(ctx, 'PUT', `/companies/${fx.companyA}`, token, body);
    expect((await put(fx.adminA.token, { alertLateCheckinMinutes: 5 })).status).toBe(403);
    expect((await put(fx.saToken, { alertMissedCheckoutMinutes: 60 })).status).toBe(400); // auto check-out closes at 60
    expect((await put(fx.saToken, { alertLateCheckinMinutes: 0 })).status).toBe(400);
    const ok = await put(fx.saToken, {
      alertLateCheckinMinutes: 10,
      alertMissedCheckinMinutes: 15,
      alertMissedCheckoutMinutes: 30,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      alertLateCheckinMinutes: 10,
      alertMissedCheckinMinutes: 15,
      alertMissedCheckoutMinutes: 30,
    });
  });
});

describe('requests and wishes', () => {
  it('a vacation request and the wishes reach the admins, and the request can be decided from the item', async () => {
    const before = (await bar(fx.adminA.token)).body.items.length;
    const q = await call(ctx, 'POST', '/me/time-off-requests', emp.maria!, {
      from: '2026-11-02',
      to: '2026-11-06',
    });
    expect(q.status).toBe(201);
    const sw = await call(ctx, 'POST', '/me/shift-wishes', emp.jon!, {
      date: '2026-11-10',
      shiftId: fx.late,
      priority: 2,
    });
    expect(sw.status).toBe(201);
    const lw = await call(ctx, 'POST', '/me/leave-wishes', emp.jon!, {
      from: '2026-12-07',
      to: '2026-12-11',
      priority: 1,
    });
    expect(lw.status).toBe(201);

    const list = await bar(fx.adminA.token);
    expect(list.body.items.length).toBe(before + 3);
    const lr = list.body.items.find((i: any) => i.kind === 'new_leave_request');
    expect(lr).toMatchObject({
      refId: q.body.id,
      from: '2026-11-02',
      to: '2026-11-06',
      status: 'pending',
      open: true,
    });
    expect(list.body.items.find((i: any) => i.kind === 'new_shift_wish')).toMatchObject({
      date: '2026-11-10',
      employeeName: 'Jon T.',
    });
    expect(list.body.items.find((i: any) => i.kind === 'new_leave_wish')).toMatchObject({
      from: '2026-12-07',
      to: '2026-12-11',
    });

    // decided with the existing approval endpoint; the item then shows the result and is no longer open
    const ok = await call(ctx, 'PUT', `/approvals/absences/${q.body.id}`, fx.adminA.token, {
      decision: 'approve',
    });
    expect(ok.status).toBe(200);
    const done = (await bar(fx.adminA.token)).body.items.find((i: any) => i.kind === 'new_leave_request');
    expect(done).toMatchObject({ status: 'approved', open: false });
  });
});

describe('scope', () => {
  it('shows each admin only the hotels they can reach; super admins see all; others are refused', async () => {
    const sa = await bar(fx.saToken);
    const a = await bar(fx.adminA.token);
    expect(sa.body.items.length).toBe(a.body.items.length);
    expect((await bar(fx.adminB.token)).body).toEqual({ items: [], unread: 0 });
    expect((await bar(hotelAdminA2)).body).toEqual({ items: [], unread: 0 });
    for (const t of [fx.mgrA1.token, emp.maria!]) expect((await bar(t)).status).toBe(403);
    expect((await call(ctx, 'GET', '/admin-alerts', null)).status).toBe(401);

    // an alert of hotel A2 reaches the hotel-limited admin and the super admin, not the admin of company B
    await runAdminAlerts(ctx.db, ctx.now.value);
    const s2 = await ctx.db
      .insertInto('schedule')
      .values({
        hotel_id: fx.hotelA2,
        employee_id: fx.emp.tom!,
        shift_date: D,
        planned_start: new Date('2026-10-20T01:00:00Z'),
        planned_end: new Date('2026-10-20T05:00:00Z'),
        status: 'published',
        created_by_user_id: fx.adminA.userId,
        created_by_role: 'admin',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    expect(s2.id).toBeGreaterThan(0);
    await runAdminAlerts(ctx.db, ctx.now.value);
    expect(kinds((await bar(hotelAdminA2)).body)).toEqual(['missed_checkin']);
    expect((await bar(fx.adminB.token)).body.items).toEqual([]);
  });

  it('a read mark belongs to the owner; foreign and out-of-scope ids are 404; the generic list does not carry alerts', async () => {
    const mine = (await bar(fx.adminA.token)).body;
    const id = mine.items[0].id;
    expect((await call(ctx, 'PUT', `/admin-alerts/${id}/read`, fx.adminB.token)).status).toBe(404);
    expect((await call(ctx, 'PUT', `/admin-alerts/${id}/read`, hotelAdminA2)).status).toBe(404);
    expect((await call(ctx, 'PUT', `/admin-alerts/${id}/read`, fx.adminA.token)).status).toBe(200);
    const after = (await bar(fx.adminA.token)).body;
    expect(after.unread).toBe(mine.unread - 1);
    expect(after.items.find((i: any) => i.id === id).read).toBe(true);
    expect((await bar(fx.adminA.token, '?unread=true')).body.items.every((i: any) => !i.read)).toBe(true);
    // the other admin of the same data is unaffected
    expect((await bar(fx.saToken)).body.unread).toBe(mine.unread);

    const all = await call(ctx, 'PUT', '/admin-alerts/read-all', fx.adminA.token);
    expect(all.body.updated).toBe(mine.unread - 1);
    expect((await bar(fx.adminA.token)).body.unread).toBe(0);

    const generic = await call(ctx, 'GET', '/notifications', fx.adminA.token);
    expect(generic.status).toBe(200);
    expect(generic.body.items.some((n: any) => String(n.kind).includes('checkin'))).toBe(false);
  });

  it('stops showing the alerts of a hotel the admin has lost', async () => {
    const before = (await bar(fx.adminA.token)).body.items.length;
    expect(before).toBeGreaterThan(0);
    await ctx.db.deleteFrom('admin_company').where('admin_id', '=', fx.adminA.adminId).execute();
    expect((await bar(fx.adminA.token)).body.items).toEqual([]);
  });
});
