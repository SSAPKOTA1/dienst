import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../src/lib/security';
import {
  call,
  empBody,
  enableTotp,
  loginAs,
  setupOrg,
  startApp,
  stopApp,
  type Org,
  type TestCtx,
} from './helpers';

let ctx: TestCtx;
let org: Org;
beforeAll(async () => {
  ctx = await startApp();
  org = await setupOrg(ctx);
});
afterAll(async () => stopApp(ctx));

const audited = async (action: string) =>
  (await ctx.db.selectFrom('audit_log').select('id').where('action', '=', action).execute()).length;

/** A person that can log in right away (the invitation flow is covered elsewhere). */
async function activate(userId: number, totp = false) {
  await ctx.db
    .updateTable('user_account')
    .set({ password_hash: await hashSecret('Passw0rd!23'), status: 'active' })
    .where('id', '=', userId)
    .execute();
  if (totp) await enableTotp(ctx.db, userId);
}

describe('super admins', () => {
  it('only a super admin creates another one; the invitation is mailed and the action audited', async () => {
    ctx.app.mailer.outbox.length = 0;
    const res = await call(ctx, 'POST', '/super-admins', org.saToken, {
      email: 'sa2@test.dev',
      firstName: 'Second',
      lastName: 'Super',
    });
    expect(res.status).toBe(201);
    expect(ctx.app.mailer.outbox[0].to).toBe('sa2@test.dev');
    expect(await audited('super_admin_created')).toBe(1);

    const body = { email: 'sa3@test.dev', firstName: 'X', lastName: 'Y' };
    expect((await call(ctx, 'POST', '/super-admins', org.adminA.token, body)).status).toBe(403);
    expect((await call(ctx, 'POST', '/super-admins', org.mgrA1.token, body)).status).toBe(403);
    expect((await call(ctx, 'POST', '/super-admins', null, body)).status).toBe(401);
    expect(
      (await call(ctx, 'POST', '/super-admins', org.saToken, { ...body, email: 'sa2@test.dev' })).status,
    ).toBe(409);

    // the new super admin can sign in (password set, authenticator enabled) and creates companies
    await activate(res.body.userId, true);
    const t = await loginAs(ctx, 'sa2@test.dev', 'superAdmin');
    expect((await call(ctx, 'POST', '/companies', t, { name: 'Made by SA2' })).status).toBe(201);
  });
});

describe('deactivating hotels', () => {
  it('is for the super admin only and hides the hotel from everybody else', async () => {
    const off = (token: string, id: number, active: boolean) =>
      call(ctx, 'PUT', `/hotels/${id}/active`, token, { active });
    expect((await off(org.adminA.token, org.hotelA2, false)).status).toBe(403);
    expect((await off(org.mgrA2.token, org.hotelA2, false)).status).toBe(403);

    const res = await off(org.saToken, org.hotelA2, false);
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect(await audited('hotel_deactivated')).toBe(1);

    const visible = async (token: string) =>
      (await call(ctx, 'GET', '/hotels', token)).body.items.map((h: any) => h.id);
    expect(await visible(org.adminA.token)).not.toContain(org.hotelA2);
    expect(await visible(org.mgrA2.token)).not.toContain(org.hotelA2);
    // the super admin still sees it (flagged), so it can be switched on again
    const sa = (await call(ctx, 'GET', '/hotels', org.saToken)).body.items;
    expect(sa.find((h: any) => h.id === org.hotelA2).isActive).toBe(false);
    expect((await call(ctx, 'GET', `/hotels/${org.hotelA2}`, org.adminA.token)).status).toBe(403);

    const on = await off(org.saToken, org.hotelA2, true);
    expect(on.body.isActive).toBe(true);
    expect(await visible(org.adminA.token)).toContain(org.hotelA2);
    expect(await audited('hotel_activated')).toBe(1);
  });

  it('is refused while somebody is still clocked in, and stops the hotel tablet', async () => {
    const emp = await call(
      ctx,
      'POST',
      '/employees',
      org.adminA.token,
      empBody(org, { email: 'open@test.dev' }),
    );
    const punch = await ctx.db
      .insertInto('punch_record')
      .values({
        employee_id: emp.body.employeeId,
        hotel_id: org.hotelA1,
        is_unplanned: true,
        shift_date: '2026-10-04',
        source: 'kiosk',
        actual_punch_in: new Date('2026-10-04T08:00:00Z'),
        paid_start: new Date('2026-10-04T08:00:00Z'),
        approval_status: 'pending',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const blocked = await call(ctx, 'PUT', `/hotels/${org.hotelA1}/active`, org.saToken, { active: false });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.code).toBe('HOTEL_HAS_OPEN_PUNCHES');
    await ctx.db
      .updateTable('punch_record')
      .set({ actual_punch_out: new Date('2026-10-04T16:00:00Z') })
      .where('id', '=', punch.id)
      .execute();

    const dev = await call(ctx, 'POST', '/kiosk-devices', org.adminA.token, {
      hotelId: org.hotelA1,
      name: 'T',
    });
    const roster = () =>
      ctx.app
        .inject({ method: 'GET', url: '/api/v1/kiosk/roster', headers: { 'x-kiosk-token': dev.body.token } })
        .then((r) => r.statusCode);
    expect(await roster()).toBe(200);
    expect(
      (await call(ctx, 'PUT', `/hotels/${org.hotelA1}/active`, org.saToken, { active: false })).status,
    ).toBe(200);
    expect(await roster()).toBe(401);
    await call(ctx, 'PUT', `/hotels/${org.hotelA1}/active`, org.saToken, { active: true });
    expect(await roster()).toBe(200);
  });
});

const contractBody = {
  validFrom: '2026-06-01',
  employmentType: 'part_time',
  workingModel: 'salary',
  workDaysPerWeek: 4,
  targetHoursPerWeek: 30,
  vacationDaysPerYear: 28,
};

describe('admins limited to single hotels', () => {
  let limited: { adminId: number; userId: number; token: string };
  let e1: number; // works at A1 only
  let e2: number; // works at A2 only
  let e3: number; // works at A1 and A2

  beforeAll(async () => {
    const mk = async (email: string, over: Record<string, unknown>) =>
      (await call(ctx, 'POST', '/employees', org.adminA.token, empBody(org, { email, ...over }))).body
        .employeeId as number;
    e1 = await mk('e1@test.dev', {});
    e2 = await mk('e2@test.dev', { primaryHotelId: org.hotelA2, primaryDepartmentId: org.deptA2 });
    e3 = await mk('e3@test.dev', { hotelIds: [org.hotelA2], departmentIds: [org.deptA1, org.deptA2] });

    const a = await call(ctx, 'POST', '/admins', org.saToken, {
      email: 'hotel.admin@test.dev',
      firstName: 'Hanna',
      lastName: 'Hotel',
      hotelIds: [org.hotelA1],
    });
    expect(a.status).toBe(201);
    await activate(a.body.userId, true);
    limited = {
      adminId: a.body.adminId,
      userId: a.body.userId,
      token: await loginAs(ctx, 'hotel.admin@test.dev', 'admin'),
    };
  });

  it('creating an admin needs at least one company or hotel; only the super admin assigns', async () => {
    const body = { email: 'none@test.dev', firstName: 'N', lastName: 'N' };
    expect((await call(ctx, 'POST', '/admins', org.saToken, body)).status).toBe(400);
    expect(
      (
        await call(ctx, 'PUT', `/admins/${limited.adminId}/access`, org.adminA.token, {
          companyIds: [],
          hotelIds: [org.hotelA1],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'PUT', `/admins/${limited.adminId}/access`, org.saToken, {
          companyIds: [],
          hotelIds: [],
        })
      ).status,
    ).toBe(400);
    const list = await call(ctx, 'GET', '/admins', org.saToken);
    const mine = list.body.items.find((x: any) => x.adminId === limited.adminId);
    expect(mine.hotelIds).toEqual([org.hotelA1]);
    expect(mine.companyIds).toEqual([]);
  });

  it('sees and lists only the hotels and employees assigned to them', async () => {
    const hotels = await call(ctx, 'GET', '/hotels', limited.token);
    expect(hotels.body.items.map((h: any) => h.id)).toEqual([org.hotelA1]);
    const companies = await call(ctx, 'GET', '/companies', limited.token);
    expect(companies.body.items).toEqual([]);

    const list = await call(ctx, 'GET', '/employees?pageSize=100', limited.token);
    const names = list.body.items.map((x: any) => x.employeeId);
    expect(names).toContain(e1);
    expect(names).toContain(e3); // also works at A2, but A1 is theirs
    expect(names).not.toContain(e2);

    expect((await call(ctx, 'GET', `/employees/${e1}`, limited.token)).status).toBe(200);
    expect((await call(ctx, 'GET', `/employees/${e2}`, limited.token)).status).toBe(403);
  });

  it('edits profile, department and contract of their own employees', async () => {
    const upd = await call(ctx, 'PUT', `/employees/${e1}`, limited.token, {
      phone: '0151 000',
      primaryDepartmentId: org.deptA1b,
      departmentIds: [org.deptA1b],
    });
    expect(upd.status).toBe(200);
    const row = await ctx.db
      .selectFrom('employee')
      .selectAll()
      .where('employee_id', '=', e1)
      .executeTakeFirstOrThrow();
    expect(row.phone).toBe('0151 000');
    expect(row.primary_department_id).toBe(org.deptA1b);

    const c = await call(ctx, 'PUT', `/employees/${e1}/contract`, limited.token, contractBody);
    expect(c.status).toBe(200);
    expect(await audited('employee_updated')).toBeGreaterThan(0);
    expect(await audited('contract_changed')).toBeGreaterThan(0);
  });

  it('cannot touch employees or hotels outside their hotels', async () => {
    expect((await call(ctx, 'PUT', `/employees/${e2}`, limited.token, { phone: '1' })).status).toBe(403);
    expect((await call(ctx, 'PUT', `/employees/${e2}/contract`, limited.token, contractBody)).status).toBe(
      403,
    );
    // moving someone to a hotel they do not manage
    expect(
      (
        await call(ctx, 'PUT', `/employees/${e1}`, limited.token, {
          primaryHotelId: org.hotelA2,
          primaryDepartmentId: org.deptA2,
          hotelIds: [org.hotelA2],
          departmentIds: [org.deptA2],
        })
      ).status,
    ).toBe(403);
    // a hotel of another company
    expect(
      (
        await call(ctx, 'PUT', `/employees/${e1}`, limited.token, {
          hotelIds: [org.hotelB1],
          departmentIds: [org.deptB1],
        })
      ).status,
    ).toBe(403);
    // inviting a manager for a hotel that is not theirs
    const m = await call(ctx, 'POST', '/managers', limited.token, {
      email: 'x.mgr@test.dev',
      firstName: 'X',
      lastName: 'M',
      hotelIds: [org.hotelA2],
    });
    expect(m.status).toBe(403);
  });

  it('keeps the assignments at other hotels when editing an employee of several hotels', async () => {
    const res = await call(ctx, 'PUT', `/employees/${e3}`, limited.token, {
      phone: '123',
      hotelIds: [org.hotelA1],
    });
    expect(res.status).toBe(200);
    const hotels = (
      await ctx.db.selectFrom('employee_hotel').select('hotel_id').where('employee_id', '=', e3).execute()
    ).map((h) => h.hotel_id);
    expect(hotels.sort()).toEqual([org.hotelA1, org.hotelA2].sort());
    const depts = (
      await ctx.db
        .selectFrom('employee_department')
        .select('department_id')
        .where('employee_id', '=', e3)
        .execute()
    ).map((d) => d.department_id);
    expect(depts).toContain(org.deptA2);
  });

  it('follows a changed assignment and loses a deactivated hotel', async () => {
    const move = await call(ctx, 'PUT', `/admins/${limited.adminId}/access`, org.saToken, {
      companyIds: [],
      hotelIds: [org.hotelA2],
    });
    expect(move.status).toBe(200);
    expect((await call(ctx, 'GET', `/employees/${e2}`, limited.token)).status).toBe(200);
    expect((await call(ctx, 'GET', `/employees/${e1}`, limited.token)).status).toBe(403);
    expect(await audited('admin_access_updated')).toBeGreaterThan(0);

    await call(ctx, 'PUT', `/hotels/${org.hotelA2}/active`, org.saToken, { active: false });
    expect((await call(ctx, 'GET', `/employees/${e2}`, limited.token)).status).toBe(403);
    await call(ctx, 'PUT', `/hotels/${org.hotelA2}/active`, org.saToken, { active: true });
  });

  it('a company admin still reaches everybody of the company, other companies stay out', async () => {
    expect((await call(ctx, 'GET', `/employees/${e1}`, org.adminA.token)).status).toBe(200);
    expect((await call(ctx, 'GET', `/employees/${e2}`, org.adminA.token)).status).toBe(200);
    expect((await call(ctx, 'GET', `/employees/${e2}`, org.adminB.token)).status).toBe(403);
  });
});

describe('staff roles of one person', () => {
  let emp: { employeeId: number; userId: number };

  beforeAll(async () => {
    const r = await call(
      ctx,
      'POST',
      '/employees',
      org.adminA.token,
      empBody(org, { email: 'pat@test.dev', firstName: 'Pat', lastName: 'Staff' }),
    );
    emp = { employeeId: r.body.employeeId, userId: r.body.userId };
    await activate(emp.userId);
  });

  it('is for the super admin only', async () => {
    for (const t of [org.adminA.token, org.mgrA1.token]) {
      expect((await call(ctx, 'GET', `/users/${emp.userId}/roles`, t)).status).toBe(403);
      expect((await call(ctx, 'PUT', `/users/${emp.userId}/roles`, t, { superAdmin: true })).status).toBe(
        403,
      );
    }
    expect((await call(ctx, 'PUT', `/users/${emp.userId}/roles`, null, { superAdmin: true })).status).toBe(
      401,
    );
    const roles = await call(ctx, 'GET', `/users/${emp.userId}/roles`, org.saToken);
    expect(roles.body).toMatchObject({ isEmployee: true, superAdmin: false, admin: null, manager: null });
    expect((await call(ctx, 'GET', '/users/999999/roles', org.saToken)).status).toBe(404);
  });

  it('makes an employee a manager, who can then sign in as one; revoking ends it at once', async () => {
    const res = await call(ctx, 'PUT', `/users/${emp.userId}/roles`, org.saToken, {
      manager: { hotelIds: [org.hotelA1] },
    });
    expect(res.status).toBe(200);
    expect(res.body.manager).toEqual({ hotelIds: [org.hotelA1] });
    expect(res.body.isEmployee).toBe(true);
    expect(await audited('staff_roles_updated')).toBe(1);

    const token = await loginAs(ctx, 'pat@test.dev', 'manager');
    expect((await call(ctx, 'GET', '/employees', token)).status).toBe(200);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'pat@test.dev', password: 'Passw0rd!23' },
    });
    expect(
      login
        .json()
        .availableRoles.map((r: any) => r.role)
        .sort(),
    ).toEqual(['employee', 'manager']);

    const gone = await call(ctx, 'PUT', `/users/${emp.userId}/roles`, org.saToken, { manager: null });
    expect(gone.body.manager).toBeNull();
    expect((await call(ctx, 'GET', '/employees', token)).status).toBe(401);
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'pat@test.dev', password: 'Passw0rd!23' },
    });
    expect((again.json().availableRoles ?? []).map((r: any) => r.role)).not.toContain('manager');
  });

  it('can make the same person an admin for chosen hotels, then restore and remove it', async () => {
    const a = await call(ctx, 'PUT', `/users/${emp.userId}/roles`, org.saToken, {
      admin: { companyIds: [], hotelIds: [org.hotelA1] },
    });
    expect(a.body.admin).toEqual({ companyIds: [], hotelIds: [org.hotelA1] });
    const second = await call(ctx, 'PUT', `/users/${emp.userId}/roles`, org.saToken, {
      admin: { companyIds: [org.companyA], hotelIds: [] },
    });
    expect(second.body.admin).toEqual({ companyIds: [org.companyA], hotelIds: [] });
    expect(
      (await call(ctx, 'GET', '/admins', org.saToken)).body.items.some(
        (x: any) => x.email === 'pat@test.dev',
      ),
    ).toBe(true);
    const none = await call(ctx, 'PUT', `/users/${emp.userId}/roles`, org.saToken, {
      admin: { companyIds: [], hotelIds: [] },
    });
    expect(none.status).toBe(400);
    const off = await call(ctx, 'PUT', `/users/${emp.userId}/roles`, org.saToken, { admin: null });
    expect(off.body.admin).toBeNull();
    expect(
      (await call(ctx, 'GET', '/admins', org.saToken)).body.items.some(
        (x: any) => x.email === 'pat@test.dev',
      ),
    ).toBe(false);
    // the role comes back with the data it had
    const back = await call(ctx, 'PUT', `/users/${emp.userId}/roles`, org.saToken, {
      admin: { companyIds: [org.companyA], hotelIds: [] },
    });
    expect(back.body.admin).toEqual({ companyIds: [org.companyA], hotelIds: [] });
    await call(ctx, 'PUT', `/users/${emp.userId}/roles`, org.saToken, { admin: null });
  });

  it('protects the super admin role and needs an e-mail address for any staff role', async () => {
    const saUser = await ctx.db
      .selectFrom('super_admin')
      .select('user_id')
      .where('super_admin_id', '=', org.superAdminId)
      .executeTakeFirstOrThrow();
    const self = await call(ctx, 'PUT', `/users/${saUser.user_id}/roles`, org.saToken, { superAdmin: false });
    expect(self.status).toBe(403);

    const granted = await call(ctx, 'PUT', `/users/${emp.userId}/roles`, org.saToken, { superAdmin: true });
    expect(granted.body.superAdmin).toBe(true);
    const removed = await call(ctx, 'PUT', `/users/${emp.userId}/roles`, org.saToken, { superAdmin: false });
    expect(removed.body.superAdmin).toBe(false);

    const noMail = await call(
      ctx,
      'POST',
      '/employees',
      org.adminA.token,
      empBody(org, { firstName: 'No', lastName: 'Mail', email: null }),
    );
    const refused = await call(ctx, 'PUT', `/users/${noMail.body.userId}/roles`, org.saToken, {
      manager: { hotelIds: [org.hotelA1] },
    });
    expect(refused.status).toBe(400);
  });
});
