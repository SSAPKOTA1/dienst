import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../src/lib/security';
import {
  call,
  empBody,
  loginAs,
  setupOrg,
  startApp,
  stopApp,
  TEST_PASSWORD,
  type Org,
  type TestCtx,
} from './helpers';

let ctx: TestCtx;
let org: Org;
beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-04T10:00:00Z') });
  org = await setupOrg(ctx);
});
afterAll(async () => stopApp(ctx));

const create = (over: Record<string, unknown> = {}, token = org.adminA.token) =>
  call(ctx, 'POST', '/employees', token, empBody(org, over));

describe('onboarding', () => {
  it('creates account, PIN, username, activation code and personnel number (no e-mail)', async () => {
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.body.pin).toMatch(/^\d{6}$/);
    expect(r.body.username).toBe('maria.schmidt');
    expect(r.body.personnelNumber).toBe('P100');
    expect(r.body.activation.method).toBe('code');
    expect(r.body.activation.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    const emp = await ctx.db
      .selectFrom('employee')
      .selectAll()
      .where('employee_id', '=', r.body.employeeId)
      .executeTakeFirstOrThrow();
    expect(emp.status).toBe('active');
    expect(emp.pin_hash).not.toContain(r.body.pin);
    const u = await ctx.db
      .selectFrom('user_account')
      .selectAll()
      .where('id', '=', r.body.userId)
      .executeTakeFirstOrThrow();
    expect(u.status).toBe('pending_invite');
    expect(u.invitation_token_hash).not.toBe(r.body.activation.code);
    // GET never shows the PIN or the code again
    const get = await call(ctx, 'GET', `/employees/${r.body.employeeId}`, org.adminA.token);
    expect(JSON.stringify(get.body)).not.toContain(r.body.pin);
    expect(JSON.stringify(get.body)).not.toContain(r.body.activation.code);
    // activation by username + code, then login by username
    const act = await call(ctx, 'POST', '/auth/accept-invitation', null, {
      username: 'maria.schmidt',
      code: r.body.activation.code,
      password: 'a-good-password-1',
    });
    expect(act.status).toBe(200);
    expect(
      (
        await call(ctx, 'POST', '/auth/login', null, {
          login: 'maria.schmidt',
          password: 'a-good-password-1',
        })
      ).body.availableRoles[0].role,
    ).toBe('employee');
  });

  it('sends an invitation mail when an e-mail is given and never mails PIN or password', async () => {
    ctx.app.mailer.outbox.length = 0;
    const r = await create({ firstName: 'Maria', lastName: 'Schmidt', email: 'maria.s@test.dev' });
    expect(r.body.username).toBe('maria.schmidt2');
    expect(r.body.activation.method).toBe('email');
    expect(r.body.activation.code).toBeUndefined();
    expect(ctx.app.mailer.outbox).toHaveLength(1);
    expect(ctx.app.mailer.outbox[0].text).not.toContain(r.body.pin);
    expect(r.body.personnelNumber).toBe('P101');
  });

  it('umlaut usernames and unique, increasing personnel numbers', async () => {
    const a = await create({ firstName: 'Jürgen', lastName: 'Müller' });
    const b = await create({ firstName: 'Anna-Lena', lastName: 'Meier' });
    expect(a.body.username).toBe('juergen.mueller');
    expect(b.body.username).toBe('annalena.meier');
    expect(a.body.personnelNumber).not.toBe(b.body.personnelNumber);
    const other = await call(
      ctx,
      'POST',
      '/employees',
      org.adminB.token,
      empBody(org, {
        primaryHotelId: org.hotelB1,
        primaryDepartmentId: org.deptB1,
        firstName: 'Bea',
        lastName: 'B',
      }),
    );
    expect(other.body.personnelNumber).toBe('P100'); // numbering is per company
  });

  it('same e-mail reuses the account (additional employee role); same company gives DUPLICATE_EMPLOYEE', async () => {
    const a = await create({ firstName: 'Tim', lastName: 'Two', email: 'tim@test.dev' });
    expect(a.status).toBe(201);
    const dup = await create({ firstName: 'Tim', lastName: 'Two', email: 'TIM@test.dev' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_EMPLOYEE');
    // person also employed by company B: one user, two employee rows
    ctx.app.mailer.outbox.length = 0;
    const b = await call(
      ctx,
      'POST',
      '/employees',
      org.adminB.token,
      empBody(org, {
        primaryHotelId: org.hotelB1,
        primaryDepartmentId: org.deptB1,
        firstName: 'Tim',
        lastName: 'Two',
        email: 'tim@test.dev',
      }),
    );
    expect(b.status).toBe(201);
    expect(b.body.activation.method).toBe('existing_account');
    expect(b.body.userId).toBe(a.body.userId);
    expect(ctx.app.mailer.outbox).toHaveLength(0);
    await ctx.db
      .updateTable('user_account')
      .set({ password_hash: await hashSecret(TEST_PASSWORD), status: 'active' })
      .where('id', '=', a.body.userId)
      .execute();
    const login = await call(ctx, 'POST', '/auth/login', null, {
      login: 'tim@test.dev',
      password: TEST_PASSWORD,
    });
    expect(login.body.availableRoles.filter((x: any) => x.role === 'employee')).toHaveLength(2);
  });

  it('prorates vacation by BUrlG and honours overrides', async () => {
    const a = await create({
      firstName: 'Late',
      lastName: 'Starter',
      contractStartDate: '2026-11-01',
      vacationDaysPerYear: 30,
    });
    const row = await ctx.db
      .selectFrom('employee_vacation_allowance')
      .selectAll()
      .where('employee_id', '=', a.body.employeeId)
      .where('year', '=', 2026)
      .executeTakeFirstOrThrow();
    expect(row.allocated_days).toBe(5);
    const b = await create({
      firstName: 'Over',
      lastName: 'Ride',
      vacationDaysAllocatedThisYear: 12.5,
      vacationDaysUsedThisYear: 2,
    });
    const row2 = await ctx.db
      .selectFrom('employee_vacation_allowance')
      .selectAll()
      .where('employee_id', '=', b.body.employeeId)
      .executeTakeFirstOrThrow();
    expect([row2.allocated_days, row2.used_days]).toEqual([12.5, 2]);
  });

  it('validates hotel/department membership and scope', async () => {
    expect((await create({ primaryDepartmentId: org.deptA2 })).status).toBe(400); // dept of another hotel
    expect((await create({ primaryHotelId: org.hotelB1, primaryDepartmentId: org.deptB1 })).status).toBe(403); // other company
    expect((await create({ hotelIds: [org.hotelB1] })).status).toBe(403);
    expect((await create({}, org.mgrA1.token)).status).toBe(403);
    expect((await create({ workingModel: 'salary', targetHoursPerWeek: null })).status).toBe(400);
  });

  it('writes audit rows without PIN or code values', async () => {
    const rows = await ctx.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'employee_created')
      .execute();
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) expect(JSON.stringify(r)).not.toMatch(/"pin":|"code":/);
    expect(ctx.logs.join('\n')).not.toMatch(/"pin":"\d{6}"/);
  });
});

describe('employee list and detail: scope and reduced views', () => {
  let sophie: number; // home hotel A2, also assigned to A1
  let piotr: number; // home hotel A1 only
  beforeAll(async () => {
    const s = await create({
      firstName: 'Sophie',
      lastName: 'Lange',
      primaryHotelId: org.hotelA2,
      primaryDepartmentId: org.deptA2,
      hotelIds: [org.hotelA1],
      departmentIds: [org.deptA1],
      email: 'sophie@test.dev',
    });
    sophie = s.body.employeeId;
    piotr = (await create({ firstName: 'Piotr', lastName: 'Nowak', primaryDepartmentId: org.deptA1b })).body
      .employeeId;
  });

  it('tenant isolation: admin B cannot read or change company A employees', async () => {
    expect((await call(ctx, 'GET', `/employees/${piotr}`, org.adminB.token)).status).toBe(403);
    expect((await call(ctx, 'PUT', `/employees/${piotr}`, org.adminB.token, { firstName: 'X' })).status).toBe(
      403,
    );
    expect((await call(ctx, 'POST', `/employees/${piotr}/reset-pin`, org.adminB.token)).status).toBe(403);
    expect((await call(ctx, 'POST', `/employees/${piotr}/deactivate`, org.adminB.token)).status).toBe(403);
    const list = await call(ctx, 'GET', '/employees', org.adminB.token);
    expect(list.body.items.every((e: any) => e.homeHotel.id === org.hotelB1)).toBe(true);
  });

  it('manager of the home hotel gets the home view, no contact data; other hotel gets the reduced view', async () => {
    const home = await call(ctx, 'GET', `/employees/${piotr}`, org.mgrA1.token);
    expect(home.status).toBe(200);
    expect(home.body.view).toBe('home');
    expect(home.body.workingWeekdays).toEqual([1, 2, 3, 4, 5]);
    expect(home.body.vacation.allocated).toBe(30);
    expect(home.body.dateOfBirth).toBeUndefined();
    expect(home.body.email).toBeUndefined();
    expect(home.body.pin).toBeUndefined();
    // Sophie: home A2, works at A1 too. Manager A1 sees the reduced view.
    const red = await call(ctx, 'GET', `/employees/${sophie}`, org.mgrA1.token);
    expect(red.body.view).toBe('reduced');
    expect(Object.keys(red.body).sort()).toEqual([
      'department',
      'displayName',
      'employeeId',
      'homeHotel',
      'isFloater',
      'isMinor',
      'personnelNumber',
      'status',
      'view',
    ]);
    expect((await call(ctx, 'GET', `/employees/${sophie}/time-account`, org.mgrA1.token)).status).toBe(403);
    expect((await call(ctx, 'GET', `/employees/${sophie}`, org.mgrA2.token)).body.view).toBe('home');
    // a manager with no hotel in common sees nothing
    expect((await call(ctx, 'GET', `/employees/${piotr}`, org.mgrA2.token)).status).toBe(403);
    const list = await call(ctx, 'GET', '/employees', org.mgrA1.token);
    const s = list.body.items.find((e: any) => e.employeeId === sophie);
    expect(s.targetHoursPerWeek).toBeUndefined();
    expect(list.body.items.find((e: any) => e.employeeId === piotr).targetHoursPerWeek).toBe(40);
    expect(list.body.items.every((e: any) => e.email === undefined)).toBe(true);
  });

  it('admin sees full data, PIN state but never the PIN; filters work', async () => {
    const d = await call(ctx, 'GET', `/employees/${piotr}`, org.adminA.token);
    expect(d.body.dateOfBirth).toBe('1990-05-12');
    expect(d.body.pin.setAt).toBeTruthy();
    expect(d.body.account.status).toBe('pending_invite');
    const q = await call(ctx, 'GET', '/employees?q=nowak', org.adminA.token);
    expect(q.body.total).toBe(1);
    const byHotel = await call(ctx, 'GET', `/employees?hotelId=${org.hotelA2}`, org.adminA.token);
    expect(byHotel.body.items.some((e: any) => e.employeeId === sophie)).toBe(true);
  });

  it('reset-pin returns a new PIN once; unlock-pin clears the lock', async () => {
    await ctx.db
      .updateTable('employee')
      .set({ pin_failed_count: 5, pin_locked_until: new Date(ctx.now.value.getTime() + 600e3) })
      .where('employee_id', '=', piotr)
      .execute();
    const r = await call(ctx, 'POST', `/employees/${piotr}/reset-pin`, org.adminA.token);
    expect(r.body.pin).toMatch(/^\d{6}$/);
    const e = await ctx.db
      .selectFrom('employee')
      .select(['pin_failed_count', 'pin_locked_until'])
      .where('employee_id', '=', piotr)
      .executeTakeFirstOrThrow();
    expect(e.pin_failed_count).toBe(0);
    await ctx.db
      .updateTable('employee')
      .set({ pin_failed_count: 3, pin_locked_until: new Date(ctx.now.value.getTime() + 600e3) })
      .where('employee_id', '=', piotr)
      .execute();
    expect((await call(ctx, 'POST', `/employees/${piotr}/unlock-pin`, org.adminA.token)).status).toBe(200);
    expect(
      (
        await ctx.db
          .selectFrom('employee')
          .select('pin_locked_until')
          .where('employee_id', '=', piotr)
          .executeTakeFirstOrThrow()
      ).pin_locked_until,
    ).toBeNull();
    expect((await call(ctx, 'POST', `/employees/${piotr}/reset-pin`, org.mgrA1.token)).status).toBe(403);
  });

  it('reset-activation issues a new single-use code for accounts without e-mail', async () => {
    const r = await call(ctx, 'POST', `/employees/${piotr}/reset-activation`, org.adminA.token);
    expect(r.body.username).toBe('piotr.nowak');
    expect(r.body.code).toMatch(/^[A-Z2-9]{10}$/);
    expect((await call(ctx, 'POST', `/employees/${sophie}/reset-activation`, org.adminA.token)).status).toBe(
      400,
    ); // has e-mail
  });

  it('contract versions: new version closes the old one; overlaps are rejected', async () => {
    const r = await call(ctx, 'PUT', `/employees/${piotr}/contract`, org.adminA.token, {
      validFrom: '2026-12-01',
      employmentType: 'part_time',
      workingModel: 'salary',
      workDaysPerWeek: 4,
      targetHoursPerWeek: 30,
      vacationDaysPerYear: 28,
    });
    expect(r.status).toBe(200);
    const list = await call(ctx, 'GET', `/employees/${piotr}/contracts`, org.adminA.token);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items[1].validTo).toBe('2026-11-30');
    expect(list.body.items[0].dailyTargetHours).toBe(7.5);
    const bad = await call(ctx, 'PUT', `/employees/${piotr}/contract`, org.adminA.token, {
      validFrom: '2026-06-01',
      employmentType: 'part_time',
      workingModel: 'salary',
      workDaysPerWeek: 4,
      targetHoursPerWeek: 30,
      vacationDaysPerYear: 28,
    });
    expect(bad.status).toBe(400);
  });

  it('deactivate keeps an account that has another role or employment', async () => {
    // Tim Two has employee rows in companies A and B (shared account)
    const tim = await ctx.db
      .selectFrom('employee')
      .select(['employee_id', 'user_id'])
      .where('company_id', '=', org.companyA)
      .where('first_name', '=', 'Tim')
      .executeTakeFirstOrThrow();
    const r = await call(ctx, 'POST', `/employees/${tim.employee_id}/deactivate`, org.adminA.token);
    expect(r.body).toEqual({ status: 'inactive', accountDisabled: false });
    const login = await call(ctx, 'POST', '/auth/login', null, {
      login: 'tim@test.dev',
      password: TEST_PASSWORD,
    });
    expect(login.body.availableRoles.filter((x: any) => x.role === 'employee')).toHaveLength(1);
    // a sole employment disables the account
    const solo = await ctx.db
      .selectFrom('employee')
      .select(['employee_id', 'user_id'])
      .where('personnel_number', '=', 'P100')
      .where('company_id', '=', org.companyA)
      .executeTakeFirstOrThrow();
    const r2 = await call(ctx, 'POST', `/employees/${solo.employee_id}/deactivate`, org.adminA.token);
    expect(r2.body.accountDisabled).toBe(true);
    expect(
      (
        await ctx.db
          .selectFrom('user_account')
          .select('status')
          .where('id', '=', solo.user_id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('disabled');
    void loginAs;
  });
});

describe('users list and setup status', () => {
  it('lists users in scope with roles and last login', async () => {
    const r = await call(ctx, 'GET', '/users', org.adminA.token);
    expect(r.status).toBe(200);
    const logins = r.body.items.map((u: any) => u.login);
    expect(logins).toContain('mgr.a1@test.dev');
    expect(logins).not.toContain('admin.b@test.dev');
    expect(r.body.items.find((u: any) => u.login === 'mgr.a1@test.dev').roles[0].role).toBe('manager');
    expect((await call(ctx, 'GET', '/users', org.mgrA1.token)).status).toBe(403);
  });

  it('setup status reflects the onboarding steps', async () => {
    const s = await call(ctx, 'GET', '/setup/status', org.adminA.token);
    expect(s.body.hotelsDepartments.done).toBe(true);
    expect(s.body.employees.done).toBe(true);
    expect(s.body.invitations.done).toBe(false);
    expect(s.body.tablet.done).toBe(false);
    expect(s.body.rules.done).toBe(false);
    expect(s.body.firstPublish.done).toBe(false);
    expect((await call(ctx, 'POST', '/setup/rules-viewed', org.adminA.token, {})).status).toBe(204);
    expect((await call(ctx, 'GET', '/setup/status', org.adminA.token)).body.rules.done).toBe(true);
    expect((await call(ctx, 'GET', `/setup/status?companyId=${org.companyB}`, org.adminA.token)).status).toBe(
      403,
    );
    const ov = await call(ctx, 'GET', '/setup/overview', org.adminA.token);
    expect(ov.body.kpis.employees).toBeGreaterThan(3);
  });
});
