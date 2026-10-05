import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupOrg, startApp, stopApp, type Org, type TestCtx } from './helpers';

let ctx: TestCtx;
let org: Org;
beforeAll(async () => {
  ctx = await startApp();
  org = await setupOrg(ctx);
});
afterAll(async () => stopApp(ctx));

describe('companies and hotels', () => {
  it('only the super admin creates companies and hotels', async () => {
    expect((await call(ctx, 'POST', '/companies', org.adminA.token, { name: 'X' })).status).toBe(403);
    const c = await call(ctx, 'POST', '/companies', org.saToken, { name: 'Company C', pinLength: 6 });
    expect(c.status).toBe(201);
    expect(
      (await call(ctx, 'POST', '/hotels', org.adminA.token, { companyId: org.companyA, name: 'X' })).status,
    ).toBe(403);
    const h = await call(ctx, 'POST', '/hotels', org.saToken, {
      companyId: c.body.id,
      name: 'C1',
      federalState: 'HE',
    });
    expect(h.status).toBe(201);
    expect(h.body.timezone).toBe('Europe/Berlin');
  });

  it('admins only see their own companies and hotels (tenant isolation)', async () => {
    const cs = await call(ctx, 'GET', '/companies', org.adminA.token);
    expect(cs.body.items.map((c: any) => c.id)).toEqual([org.companyA]);
    const hs = await call(ctx, 'GET', '/hotels', org.adminA.token);
    expect(hs.body.items.map((h: any) => h.id).sort()).toEqual([org.hotelA1, org.hotelA2].sort());
    expect((await call(ctx, 'GET', `/hotels/${org.hotelB1}`, org.adminA.token)).status).toBe(403);
    expect((await call(ctx, 'GET', `/hotels/${org.hotelB1}/settings`, org.adminA.token)).status).toBe(403);
    expect(
      (
        await call(ctx, 'PUT', `/hotels/${org.hotelB1}/settings`, org.adminA.token, {
          employeeHoursVisibility: 'immediately',
        })
      ).status,
    ).toBe(403);
    expect((await call(ctx, 'GET', '/hotels', org.mgrA1.token)).body.items.map((h: any) => h.id)).toEqual([
      org.hotelA1,
    ]);
    expect((await call(ctx, 'GET', `/hotels/${org.hotelA2}`, org.mgrA1.token)).status).toBe(403);
  });

  it('hours-visibility setting: admin writes, manager reads only', async () => {
    const put = await call(ctx, 'PUT', `/hotels/${org.hotelA1}/settings`, org.adminA.token, {
      employeeHoursVisibility: 'immediately',
    });
    expect(put.status).toBe(200);
    expect(
      (await call(ctx, 'GET', `/hotels/${org.hotelA1}/settings`, org.mgrA1.token)).body
        .employeeHoursVisibility,
    ).toBe('immediately');
    expect(
      (
        await call(ctx, 'PUT', `/hotels/${org.hotelA1}/settings`, org.mgrA1.token, {
          employeeHoursVisibility: 'after_approval',
        })
      ).status,
    ).toBe(403);
    await call(ctx, 'PUT', `/hotels/${org.hotelA1}/settings`, org.adminA.token, {
      employeeHoursVisibility: 'after_approval',
    });
    const audit = await ctx.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'hotel_settings_updated')
      .execute();
    expect(audit.length).toBe(2);
  });
});

describe('admins and managers', () => {
  it('SA creates an admin with invitation mail; AD creates a manager only for own hotels', async () => {
    ctx.app.mailer.outbox.length = 0;
    const a = await call(ctx, 'POST', '/admins', org.saToken, {
      email: 'new.admin@test.dev',
      firstName: 'New',
      lastName: 'Admin',
      companyIds: [org.companyB],
    });
    expect(a.status).toBe(201);
    expect(ctx.app.mailer.outbox[0].to).toBe('new.admin@test.dev');
    expect(
      (
        await call(ctx, 'POST', '/admins', org.adminA.token, {
          email: 'x@test.dev',
          firstName: 'X',
          lastName: 'Y',
          companyIds: [org.companyA],
        })
      ).status,
    ).toBe(403);
    const m = await call(ctx, 'POST', '/managers', org.adminA.token, {
      email: 'new.mgr@test.dev',
      firstName: 'New',
      lastName: 'Mgr',
      hotelIds: [org.hotelA1, org.hotelA2],
    });
    expect(m.status).toBe(201);
    expect(
      (
        await call(ctx, 'POST', '/managers', org.adminA.token, {
          email: 'bad.mgr@test.dev',
          firstName: 'B',
          lastName: 'M',
          hotelIds: [org.hotelB1],
        })
      ).status,
    ).toBe(403);
    const list = await call(ctx, 'GET', '/managers', org.adminA.token);
    expect(list.body.items.some((x: any) => x.email === 'new.mgr@test.dev')).toBe(true);
    const upd = await call(ctx, 'PUT', `/managers/${m.body.managerId}/hotels`, org.adminA.token, {
      hotelIds: [org.hotelA1],
    });
    expect(upd.status).toBe(200);
    expect(
      (
        await call(ctx, 'PUT', `/managers/${m.body.managerId}/hotels`, org.adminA.token, {
          hotelIds: [org.hotelB1],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'POST', '/managers', org.mgrA1.token, {
          email: 'q@test.dev',
          firstName: 'Q',
          lastName: 'Q',
          hotelIds: [org.hotelA1],
        })
      ).status,
    ).toBe(403);
  });
});

describe('departments', () => {
  it('CRUD within scope; delete blocked while in use', async () => {
    const d = await call(ctx, 'POST', '/departments', org.adminA.token, {
      hotelId: org.hotelA1,
      name: 'Frühstück',
      color: '#ec3013',
    });
    expect(d.status).toBe(201);
    expect(
      (await call(ctx, 'POST', '/departments', org.adminA.token, { hotelId: org.hotelB1, name: 'X' })).status,
    ).toBe(403);
    expect(
      (await call(ctx, 'PUT', `/departments/${d.body.id}`, org.adminA.token, { name: 'Breakfast' })).body
        .name,
    ).toBe('Breakfast');
    expect(
      (await call(ctx, 'GET', '/departments', org.mgrA1.token)).body.items.every(
        (x: any) => x.hotelId === org.hotelA1,
      ),
    ).toBe(true);
    expect(
      (await call(ctx, 'POST', '/departments', org.mgrA1.token, { hotelId: org.hotelA1, name: 'Y' })).status,
    ).toBe(403);
    expect((await call(ctx, 'DELETE', `/departments/${d.body.id}`, org.adminA.token)).status).toBe(204);
    expect((await call(ctx, 'DELETE', `/departments/${org.deptB1}`, org.adminA.token)).status).toBe(403);
  });
});

describe('kiosk devices', () => {
  it('registers a device, returns the token once, tracks online state and revokes', async () => {
    const d = await call(ctx, 'POST', '/kiosk-devices', org.adminA.token, {
      hotelId: org.hotelA1,
      name: 'Rezeption Tablet',
    });
    expect(d.status).toBe(201);
    expect(d.body.token).toMatch(/^kd_/);
    const list = await call(ctx, 'GET', '/kiosk-devices', org.adminA.token);
    expect(list.body.items[0].token).toBeUndefined();
    expect(list.body.items[0].online).toBe(false);
    await ctx.db
      .updateTable('kiosk_device')
      .set({ last_seen_at: new Date(ctx.now.value.getTime() - 60e3) })
      .execute();
    expect((await call(ctx, 'GET', '/kiosk-devices', org.adminA.token)).body.items[0].online).toBe(true);
    await ctx.db
      .updateTable('kiosk_device')
      .set({ last_seen_at: new Date(ctx.now.value.getTime() - 4 * 60e3) })
      .execute();
    expect((await call(ctx, 'GET', '/kiosk-devices', org.adminA.token)).body.items[0].online).toBe(false);
    expect(
      (await call(ctx, 'POST', '/kiosk-devices', org.adminA.token, { hotelId: org.hotelB1, name: 'x' }))
        .status,
    ).toBe(403);
    expect(
      (await call(ctx, 'POST', '/kiosk-devices', org.mgrA1.token, { hotelId: org.hotelA1, name: 'x' }))
        .status,
    ).toBe(403);
    expect(
      (await call(ctx, 'PUT', `/kiosk-devices/${d.body.id}`, org.adminA.token, { status: 'revoked' })).body
        .status,
    ).toBe('revoked');
  });
});

describe('holidays', () => {
  it('resolves hotel > company > state > national and allows cancelling', async () => {
    const ins = (v: object) =>
      ctx.db
        .insertInto('public_holiday')
        .values(v as any)
        .execute();
    await ins({ scope: 'national', date: '2026-10-03', name: 'Tag der Deutschen Einheit' });
    await ins({ scope: 'state', federal_state: 'HE', date: '2026-12-25', name: 'Weihnachten HE' });
    await ins({ scope: 'state', federal_state: 'BE', date: '2026-03-08', name: 'Frauentag' });
    const res = await call(ctx, 'GET', `/holidays?hotelId=${org.hotelA1}&year=2026`, org.mgrA1.token);
    expect(res.body.items.map((h: any) => h.date)).toEqual(['2026-10-03', '2026-12-25']);
    const add = await call(ctx, 'POST', '/holidays', org.adminA.token, {
      scope: 'hotel',
      hotelId: org.hotelA1,
      date: '2026-10-03',
      name: 'cancelled',
      isHoliday: false,
    });
    expect(add.status).toBe(201);
    const res2 = await call(ctx, 'GET', `/holidays?hotelId=${org.hotelA1}&year=2026`, org.adminA.token);
    expect(res2.body.items.map((h: any) => h.date)).toEqual(['2026-12-25']);
    const co = await call(ctx, 'POST', '/holidays', org.adminA.token, {
      scope: 'company',
      companyId: org.companyA,
      date: '2026-06-01',
      name: 'Firmenfeiertag',
    });
    expect(co.status).toBe(201);
    expect(
      (
        await call(ctx, 'GET', `/holidays?hotelId=${org.hotelA2}&year=2026`, org.adminA.token)
      ).body.items.some((h: any) => h.date === '2026-06-01'),
    ).toBe(true);
    expect(
      (await call(ctx, 'GET', `/holidays?hotelId=${org.hotelB1}&year=2026`, org.adminA.token)).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'POST', '/holidays', org.adminA.token, {
          scope: 'company',
          companyId: org.companyB,
          date: '2026-06-02',
          name: 'x',
        })
      ).status,
    ).toBe(403);
    expect((await call(ctx, 'DELETE', `/holidays/${co.body.id}`, org.adminA.token)).status).toBe(204);
  });
});
