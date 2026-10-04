import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupOrg, startApp, stopApp, type Org, type TestCtx } from './helpers';

let ctx: TestCtx;
let org: Org;
beforeAll(async () => {
  ctx = await startApp();
  org = await setupOrg(ctx);
});
afterAll(async () => stopApp(ctx));

const shiftBody = (over: Record<string, unknown> = {}) => ({
  hotelId: org.hotelA1,
  departmentId: org.deptA1,
  name: 'Früh',
  startTime: '06:00',
  endTime: '14:00',
  breakMinutes: 30,
  ...over,
});

describe('shift CRUD', () => {
  it('creates, lists, updates and deletes within scope', async () => {
    const c = await call(ctx, 'POST', '/shifts', org.mgrA1.token, shiftBody());
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ name: 'Früh', startTime: '06:00', endTime: '14:00', breakMinutes: 30 });
    const night = await call(
      ctx,
      'POST',
      '/shifts',
      org.adminA.token,
      shiftBody({ name: 'Nacht', startTime: '22:00', endTime: '06:00' }),
    );
    expect(night.status).toBe(201);
    const list = await call(ctx, 'GET', `/shifts?hotelId=${org.hotelA1}`, org.mgrA1.token);
    expect(list.body.items.map((s: any) => s.name)).toEqual(['Früh', 'Nacht']);
    expect(
      (await call(ctx, 'PUT', `/shifts/${c.body.id}`, org.mgrA1.token, { name: 'Early', breakMinutes: 45 }))
        .body,
    ).toMatchObject({ name: 'Early', breakMinutes: 45 });
    expect((await call(ctx, 'DELETE', `/shifts/${night.body.id}`, org.mgrA1.token)).status).toBe(204);
    const audit = await ctx.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', 'like', 'shift_%')
      .execute();
    expect(audit.map((a) => a.action).sort()).toEqual([
      'shift_created',
      'shift_created',
      'shift_deleted',
      'shift_updated',
    ]);
  });

  it('respects hotel scope and department/hotel consistency', async () => {
    expect(
      (
        await call(
          ctx,
          'POST',
          '/shifts',
          org.mgrA1.token,
          shiftBody({ hotelId: org.hotelA2, departmentId: org.deptA2 }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          ctx,
          'POST',
          '/shifts',
          org.adminA.token,
          shiftBody({ hotelId: org.hotelB1, departmentId: org.deptB1 }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await call(ctx, 'POST', '/shifts', org.adminA.token, shiftBody({ departmentId: org.deptA2 }))).status,
    ).toBe(400);
    expect(
      (await call(ctx, 'POST', '/shifts', org.adminA.token, shiftBody({ startTime: '25:00' }))).status,
    ).toBe(400);
    const other = await call(
      ctx,
      'POST',
      '/shifts',
      org.adminB.token,
      shiftBody({ hotelId: org.hotelB1, departmentId: org.deptB1 }),
    );
    expect((await call(ctx, 'PUT', `/shifts/${other.body.id}`, org.adminA.token, { name: 'x' })).status).toBe(
      403,
    );
    expect((await call(ctx, 'GET', `/shifts?hotelId=${org.hotelB1}`, org.adminA.token)).status).toBe(403);
    expect(
      (await call(ctx, 'GET', '/shifts', org.mgrA1.token)).body.items.every(
        (s: any) => s.hotelId === org.hotelA1,
      ),
    ).toBe(true);
    expect((await call(ctx, 'DELETE', `/shifts/${other.body.id}`, org.mgrA1.token)).status).toBe(403);
  });

  it('refuses to delete a shift that is used in the schedule', async () => {
    const s = await call(ctx, 'POST', '/shifts', org.adminA.token, shiftBody({ name: 'Used' }));
    const e = await call(ctx, 'POST', '/employees', org.adminA.token, {
      firstName: 'A',
      lastName: 'B',
      dateOfBirth: '1990-01-01',
      primaryHotelId: org.hotelA1,
      primaryDepartmentId: org.deptA1,
      contractStartDate: '2026-01-01',
      employmentType: 'full_time',
      workingModel: 'hourly',
      workDaysPerWeek: 5,
      vacationDaysPerYear: 30,
    });
    await ctx.db
      .insertInto('schedule')
      .values({
        hotel_id: org.hotelA1,
        employee_id: e.body.employeeId,
        shift_id: s.body.id,
        shift_date: '2026-10-12',
        planned_start: new Date('2026-10-12T04:00:00Z'),
        planned_end: new Date('2026-10-12T12:00:00Z'),
        created_by_user_id: org.adminA.userId,
        created_by_role: 'admin',
      })
      .execute();
    const d = await call(ctx, 'DELETE', `/shifts/${s.body.id}`, org.adminA.token);
    expect(d.status).toBe(409);
  });
});

describe('staffing requirements', () => {
  it('stores weekday defaults and date overrides; resolution is override > weekday > 0', async () => {
    const s = await call(ctx, 'POST', '/shifts', org.adminA.token, shiftBody({ name: 'Staffed' }));
    const put = await call(ctx, 'PUT', `/shifts/${s.body.id}/staffing`, org.mgrA1.token, {
      weekdayDefaults: { '1': 3, '2': 3, '3': 3, '4': 3, '5': 3, '6': 1, '7': 1 },
      overrides: [
        { date: '2026-12-24', count: 0 },
        { date: '2026-10-13', count: 5 },
      ],
    });
    expect(put.status).toBe(200);
    const get = await call(ctx, 'GET', `/shifts/${s.body.id}/staffing`, org.mgrA1.token);
    expect(get.body.weekdayDefaults).toEqual({ '1': 3, '2': 3, '3': 3, '4': 3, '5': 3, '6': 1, '7': 1 });
    expect(get.body.overrides).toEqual([
      { date: '2026-10-13', count: 5 },
      { date: '2026-12-24', count: 0 },
    ]);
    const { loadStaffing, requiredOn } = await import('../src/services/staffing');
    const st = (await loadStaffing(ctx.db, [s.body.id])).get(s.body.id)!;
    expect(requiredOn(st, '2026-10-12')).toBe(3); // Monday default
    expect(requiredOn(st, '2026-10-13')).toBe(5); // Tuesday override beats default 3
    expect(requiredOn(st, '2026-10-17')).toBe(1); // Saturday
    expect(requiredOn(st, '2026-12-24')).toBe(0); // override of 0 beats the Thursday default
    // replace: removing weekday 6/7 leaves "no requirement" = 0
    await call(ctx, 'PUT', `/shifts/${s.body.id}/staffing`, org.adminA.token, {
      weekdayDefaults: { '1': 2 },
      overrides: [],
    });
    const st2 = (await loadStaffing(ctx.db, [s.body.id])).get(s.body.id)!;
    expect(requiredOn(st2, '2026-10-12')).toBe(2);
    expect(requiredOn(st2, '2026-10-17')).toBe(0);
    expect(requiredOn(undefined, '2026-10-12')).toBe(0);
  });

  it('is scoped and validated', async () => {
    const s = await call(ctx, 'POST', '/shifts', org.adminA.token, shiftBody({ name: 'Scope' }));
    expect(
      (
        await call(ctx, 'PUT', `/shifts/${s.body.id}/staffing`, org.mgrA2.token, {
          weekdayDefaults: { '1': 1 },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'PUT', `/shifts/${s.body.id}/staffing`, org.adminB.token, {
          weekdayDefaults: { '1': 1 },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'PUT', `/shifts/${s.body.id}/staffing`, org.adminA.token, {
          weekdayDefaults: { '9': 1 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(ctx, 'PUT', `/shifts/${s.body.id}/staffing`, org.adminA.token, {
          weekdayDefaults: { '1': -1 },
        })
      ).status,
    ).toBe(400);
    expect((await call(ctx, 'GET', `/shifts/${s.body.id}/staffing`, org.mgrA2.token)).status).toBe(403);
  });
});
