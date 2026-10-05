import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { computeTimeAccount } from '../src/services/timeAccount';
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

const get = (url: string, token: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
const punch = (
  key: string,
  date: string,
  from: string,
  to: string,
  hours: number,
  over: Record<string, unknown> = {},
) =>
  ctx.db
    .insertInto('punch_record')
    .values({
      employee_id: fx.emp[key]!,
      hotel_id: fx.hotelA1,
      shift_date: date,
      actual_punch_in: new Date(from),
      actual_punch_out: new Date(to),
      paid_start: new Date(from),
      paid_end: new Date(to),
      actual_break_minutes: 0,
      required_break_minutes: 0,
      paid_hours: hours,
      approval_status: 'approved',
      ...over,
    } as any)
    .execute();

beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-20T10:00:00Z') });
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  emp = await employeeTokens(ctx, fx, ['maria', 'jon', 'cap']);
});
afterAll(async () => stopApp(ctx));

describe('time account ledger', () => {
  it('lines add up to the balance and manual corrections and payouts move it', async () => {
    await punch('maria', '2026-09-08', '2026-09-08T05:00:00Z', '2026-09-08T13:00:00Z', 8);
    const l = await call(ctx, 'GET', `/employees/${fx.emp.maria}/time-account/ledger`, fx.mgrA1.token);
    expect(l.status).toBe(200);
    const sum = l.body.lines.reduce((a: number, x: any) => a + x.hours, 0);
    expect(Math.abs(sum - l.body.balanceHours)).toBeLessThan(0.05);
    expect(l.body.balanceHours).toBe(await computeTimeAccount(ctx.db, fx.emp.maria!, '2026-10-20'));
    expect(l.body.lines.some((x: any) => x.type === 'worked' && x.hours === 8)).toBe(true);
    expect(l.body.lines.filter((x: any) => x.type === 'target').length).toBeGreaterThan(5);
    const before = l.body.balanceHours;

    const c = await call(ctx, 'POST', `/employees/${fx.emp.maria}/time-account/entries`, fx.adminA.token, {
      date: '2026-10-01',
      type: 'correction',
      hours: 5,
      note: 'Altes Guthaben',
    });
    expect(c.status).toBe(201);
    const p = await call(ctx, 'POST', `/employees/${fx.emp.maria}/time-account/entries`, fx.adminA.token, {
      date: '2026-10-02',
      type: 'payout',
      hours: 3,
      note: 'Auszahlung Oktober',
    });
    expect(p.body.hours).toBe(-3);
    const after = await call(ctx, 'GET', `/me/time-account/ledger`, emp.maria!);
    expect(after.body.balanceHours).toBe(Math.round((before + 2) * 100) / 100);
    expect(
      after.body.lines
        .filter((x: any) => x.type === 'payout' || x.type === 'correction')
        .map((x: any) => x.hours),
    ).toEqual([5, -3]);
    expect(
      (await call(ctx, 'GET', `/employees/${fx.emp.maria}/time-account`, fx.mgrA1.token)).body.balanceHours,
    ).toBe(after.body.balanceHours);

    expect(
      (
        await call(ctx, 'POST', `/employees/${fx.emp.maria}/time-account/entries`, fx.mgrA1.token, {
          date: '2026-10-01',
          type: 'correction',
          hours: 1,
          note: 'nope',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'POST', `/employees/${fx.emp.maria}/time-account/entries`, fx.adminB.token, {
          date: '2026-10-01',
          type: 'correction',
          hours: 1,
          note: 'nope',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'POST', `/employees/${fx.emp.maria}/time-account/entries`, fx.adminA.token, {
          date: '2026-10-01',
          type: 'correction',
          hours: 0,
          note: 'zero',
        })
      ).status,
    ).toBe(400);
    // hourly employees have no account
    expect(
      (
        await call(ctx, 'POST', `/employees/${fx.emp.cap}/time-account/entries`, fx.adminA.token, {
          date: '2026-10-01',
          type: 'correction',
          hours: 1,
          note: 'hourly',
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(ctx, 'GET', `/employees/${fx.emp.maria}/time-account/ledger`, fx.mgrA2.token)).status,
    ).toBe(403);
    expect(
      (await call(ctx, 'GET', `/employees/${fx.emp.cap}/time-account/ledger`, fx.adminA.token)).body
        .balanceHours,
    ).toBeNull();
  });

  it('comp time needs a sufficient balance (reason otherwise) and a time account', async () => {
    const abs = { employeeId: fx.emp.jon, from: '2026-12-01', to: '2026-12-03', type: 'comp_time' };
    const need = await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, abs);
    expect(need.status).toBe(422);
    expect(need.body.error.details.violations[0]).toMatchObject({
      code: 'COMP_TIME_EXCEEDS',
      severity: 'needs_reason',
    });
    await ctx.db
      .updateTable('employee')
      .set({ opening_balance_hours: 3000 })
      .where('employee_id', '=', fx.emp.jon!)
      .execute();
    const ok = await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, abs);
    expect(ok.status).toBe(201);
    const bal = await call(ctx, 'GET', `/employees/${fx.emp.jon}/time-account/ledger?`, fx.adminA.token);
    expect(bal.body.balanceHours).toBeTypeOf('number');
    expect(
      (
        await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
          ...abs,
          employeeId: fx.emp.cap,
          from: '2026-12-08',
          to: '2026-12-08',
        })
      ).status,
    ).toBe(400);
    // the other extra types are accepted
    expect(
      (
        await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
          employeeId: fx.emp.maria,
          from: '2026-12-14',
          to: '2026-12-14',
          type: 'training',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
          employeeId: fx.emp.maria,
          from: '2026-12-15',
          to: '2026-12-15',
          type: 'rest_day',
        })
      ).status,
    ).toBe(201);
  });
});

describe('hour categories and payroll export', () => {
  it('computes night and Sunday minutes in hotel-local time and exports them (month must be closed)', async () => {
    // Sunday 2026-09-06 21:00 -> 03:00 local (UTC 19:00 -> 01:00)
    await punch('maria', '2026-09-06', '2026-09-06T19:00:00Z', '2026-09-07T01:00:00Z', 6);
    const j = await call(ctx, 'GET', `/payroll/export?month=2026-09&hotelIds=${fx.hotelA1}`, fx.adminA.token);
    expect(j.status).toBe(200);
    const row = j.body.rows.find((x: any) => x.name === 'Test, Maria');
    expect(row.workedHours).toBe(14);
    expect(row.categoryHours).toMatchObject({ night: 4, sunday: 3 });
    expect(row.absenceDays).toEqual({});
    expect(j.body.periodClosed).toBe(false);
    expect(j.body.categories.map((c: any) => c.code)).toEqual(
      expect.arrayContaining(['night', 'sunday', 'holiday', 'special_eve']),
    );
    // CSV needs a closed month
    const csv0 = await get(
      `/payroll/export?month=2026-09&hotelIds=${fx.hotelA1}&format=csv`,
      fx.adminA.token,
    );
    expect(csv0.statusCode).toBe(409);
    const prev = await get(
      `/payroll/export?month=2026-09&hotelIds=${fx.hotelA1}&format=csv&includeOpen=true`,
      fx.adminA.token,
    );
    expect(prev.statusCode).toBe(200);
    expect(prev.body.charCodeAt(0)).toBe(0xfeff);
    expect(prev.body.split('\r\n')[0]).toContain('Std Nachtarbeit');
    expect(prev.body).toContain('Test, Maria');
    expect(prev.body).not.toMatch(/Stundensatz|Euro|EUR|wage/i);
    // close the month for company A, then the plain export works, as Excel too
    expect(
      (
        await call(ctx, 'POST', '/periods/close', fx.adminA.token, {
          companyId: fx.companyA,
          from: '2026-09-01',
          to: '2026-09-30',
        })
      ).status,
    ).toBe(200);
    const csv = await get(`/payroll/export?month=2026-09&hotelIds=${fx.hotelA1}&format=csv`, fx.adminA.token);
    expect(csv.statusCode).toBe(200);
    const x = await get(`/payroll/export?month=2026-09&hotelIds=${fx.hotelA1}&format=xlsx`, fx.adminA.token);
    expect(x.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as any);
    expect(wb.getWorksheet('Lohnexport')!.getRow(1).getCell(1).value).toBe('Personalnummer');
    // scope and roles
    expect(
      (await get(`/payroll/export?month=2026-09&hotelIds=${fx.hotelA1}`, fx.mgrA1.token)).statusCode,
    ).toBe(403);
    expect(
      (await get(`/payroll/export?month=2026-09&hotelIds=${fx.hotelA1}`, fx.adminB.token)).statusCode,
    ).toBe(403);
    expect((await get(`/payroll/export?month=2026-13`, fx.adminA.token)).statusCode).toBe(400);
  });

  it('companies can add, change, deactivate and delete their own categories; system ones are protected', async () => {
    const list = await call(ctx, 'GET', '/hour-categories', fx.mgrA1.token);
    expect(list.body.items.every((c: any) => c.system)).toBe(true);
    expect(list.body.items.find((c: any) => c.code === 'night')).toMatchObject({ id: null, system: true });
    expect(
      (
        await call(ctx, 'POST', '/hour-categories', fx.adminA.token, {
          code: 'bad',
          name: 'Bad',
          rule: { weekday: 9 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(ctx, 'POST', '/hour-categories', fx.mgrA1.token, {
          code: 'x1',
          name: 'X',
          rule: { weekday: 6 },
        })
      ).status,
    ).toBe(403);
    const sat = await call(ctx, 'POST', '/hour-categories', fx.adminA.token, {
      code: 'saturday',
      name: 'Samstag',
      rule: { weekday: 6 },
    });
    expect(sat.status).toBe(201);
    expect(
      (
        await call(ctx, 'POST', '/hour-categories', fx.adminA.token, {
          code: 'saturday',
          name: 'Samstag',
          rule: { weekday: 6 },
        })
      ).status,
    ).toBe(409);
    // override a system category: deactivate "night" for this company only
    const off = await call(ctx, 'POST', '/hour-categories', fx.adminA.token, {
      code: 'night',
      name: 'Nacht',
      rule: { daily: { from: '23:00', to: '06:00' } },
      active: false,
    });
    expect(off.status).toBe(201);
    const after = await call(ctx, 'GET', '/hour-categories', fx.adminA.token);
    expect(after.body.items.map((c: any) => c.code)).toEqual(expect.arrayContaining(['saturday', 'sunday']));
    expect(after.body.items.map((c: any) => c.code)).not.toContain('night');
    expect(
      (await call(ctx, 'GET', '/hour-categories', fx.adminB.token)).body.items.map((c: any) => c.code),
    ).toContain('night');
    expect((await call(ctx, 'DELETE', `/hour-categories/${off.body.id}`, fx.adminA.token)).status).toBe(204);
    expect(
      (
        await call(ctx, 'PUT', `/hour-categories/${sat.body.id}`, fx.adminB.token, {
          name: 'x',
          rule: { weekday: 6 },
          active: true,
        })
      ).status,
    ).toBe(403);
  });
});

describe('rule profiles', () => {
  it('may only be stricter, change the planning checks and can be reset per hotel and company', async () => {
    const day = {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.maria,
      shiftId: fx.early,
      start: '08:00',
      end: '16:30',
      plannedBreakMinutes: 30,
    };
    // 08:00-16:30 with 30 min break = 8 h: fine by default
    const first = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      ...day,
      date: '2027-02-01',
    });
    expect(first.status).toBe(201);
    const def = await call(ctx, 'GET', `/settings/rules?companyId=${fx.companyA}`, fx.mgrA1.token);
    expect(def.body).toMatchObject({
      customised: false,
      limits: { dailyMaxMinutes: 600, restWarnMinutes: 660 },
    });
    expect(
      (
        await call(ctx, 'PUT', `/settings/rules?companyId=${fx.companyA}`, fx.adminA.token, {
          limits: { dailyMaxMinutes: 700 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(ctx, 'PUT', `/settings/rules?companyId=${fx.companyA}`, fx.mgrA1.token, {
          limits: { dailyMaxMinutes: 500 },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'PUT', `/settings/rules?companyId=${fx.companyA}`, fx.adminB.token, {
          limits: { dailyMaxMinutes: 500 },
        })
      ).status,
    ).toBe(403);
    // a company limit of 7 h blocks the 8 h day
    const put = await call(ctx, 'PUT', `/settings/rules?companyId=${fx.companyA}`, fx.adminA.token, {
      limits: { dailyMaxMinutes: 420, dailyWarnMinutes: 400 },
    });
    expect(put.status).toBe(200);
    const blocked = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      ...day,
      date: '2027-02-02',
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.details.violations[0].code).toBe('DAILY_LIMIT');
    // hotel A2 uses the company profile too; a hotel override resets it for A1 only
    expect(
      (
        await call(
          ctx,
          'PUT',
          `/settings/rules?companyId=${fx.companyA}&hotelId=${fx.hotelA1}`,
          fx.adminA.token,
          { limits: { dailyMaxMinutes: 600 } },
        )
      ).status,
    ).toBe(200);
    expect(
      (await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, { ...day, date: '2027-02-02' })).status,
    ).toBe(201);
    expect(
      (
        await call(
          ctx,
          'DELETE',
          `/settings/rules?companyId=${fx.companyA}&hotelId=${fx.hotelA1}`,
          fx.adminA.token,
        )
      ).status,
    ).toBe(204);
    expect(
      (await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, { ...day, date: '2027-02-03' })).status,
    ).toBe(422);
    expect(
      (await call(ctx, 'DELETE', `/settings/rules?companyId=${fx.companyA}`, fx.adminA.token)).status,
    ).toBe(204);
    expect(
      (await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, { ...day, date: '2027-02-03' })).status,
    ).toBe(201);
    const audits = await ctx.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', 'in', ['rule_profile_changed', 'rule_profile_reset'])
      .execute();
    expect(audits.length).toBeGreaterThanOrEqual(3);
  });

  it('Sunday and night statistics warn once stricter limits are exceeded', async () => {
    await call(ctx, 'PUT', `/settings/rules?companyId=${fx.companyA}`, fx.adminA.token, {
      limits: { sundaysFreeMin: 52, nightWorkerNights: 1 },
    });
    // 2027-01-03 is a Sunday
    const sun = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.early,
      date: '2027-01-03',
    });
    expect(sun.body.warnings.map((w: any) => w.code)).toContain('SUNDAY_LIMIT');
    const night = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.night,
      date: '2027-01-12',
    });
    expect(night.body.warnings.map((w: any) => w.code)).toContain('NIGHT_WORKER');
    await call(ctx, 'DELETE', `/settings/rules?companyId=${fx.companyA}`, fx.adminA.token);
    const plain = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.night,
      date: '2027-01-19',
    });
    expect(plain.body.warnings.map((w: any) => w.code)).not.toContain('NIGHT_WORKER');
    const rep = await call(
      ctx,
      'GET',
      `/compliance/sundays-nights?year=2027&hotelIds=${fx.hotelA1}`,
      fx.mgrA1.token,
    );
    const jon = rep.body.items.find((i: any) => i.displayName === 'Jon T.');
    expect(jon).toMatchObject({ sundaysWorked: 1, sundaysFree: 51, sundaysTotal: 52 });
  });
});

describe('compliance reports', () => {
  it('lists shortened rests with their compensation and Sunday work without a replacement rest day', async () => {
    const m = fx.emp.maria!;
    const entry = (shiftId: number, date: string, employeeId = m) =>
      call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
        hotelId: fx.hotelA1,
        employeeId,
        shiftId,
        date,
        overrideReason: 'Betrieb',
      });
    // Mon 2027-03-08 Spät (14-22), Tue Früh (06-14) is 8 h rest -> blocked; use Mi: Spät until 22:00, next Früh 08:30 needs explicit times
    await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: m,
      shiftId: fx.late,
      date: '2027-03-08',
    });
    const short = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: m,
      shiftId: fx.early,
      date: '2027-03-09',
      start: '08:30',
      end: '16:30',
      overrideReason: 'Kurzfristige Besetzung',
    });
    expect(short.status).toBe(201);
    const open = await call(
      ctx,
      'GET',
      `/compliance/rest-compensation?from=2027-03-01&to=2027-03-31&hotelIds=${fx.hotelA1}`,
      fx.mgrA1.token,
    );
    expect(open.body.items).toHaveLength(1);
    expect(open.body.items[0]).toMatchObject({ displayName: 'Maria T.', gapMinutes: 630, status: 'open' });
    // a 12 h+ rest follows: Thu 06:00 start after 16:30 end is 13.5 h
    await entry(fx.early, '2027-03-10');
    const ok = await call(
      ctx,
      'GET',
      `/compliance/rest-compensation?from=2027-03-01&to=2027-03-31&hotelIds=${fx.hotelA1}`,
      fx.mgrA1.token,
    );
    expect(ok.body.items[0].status).toBe('ok');
    expect(
      (
        await call(
          ctx,
          'GET',
          `/compliance/rest-compensation?from=2027-03-01&to=2027-03-31&hotelIds=${fx.hotelA2}`,
          fx.mgrA1.token,
        )
      ).status,
    ).toBe(403);

    // Sunday work needs a replacement rest day within 14 days
    await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.tom,
      shiftId: fx.early,
      date: '2027-03-14',
    }); // Sunday
    const none = await call(
      ctx,
      'GET',
      `/compliance/replacement-rest?from=2027-03-01&to=2027-03-31&hotelIds=${fx.hotelA1}`,
      fx.mgrA1.token,
    );
    const tom = none.body.items.find((i: any) => i.displayName === 'Tom T.');
    expect(tom).toMatchObject({ kind: 'sunday', dueBy: '2027-03-28', status: 'open', restDayOn: null });
    await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
      employeeId: fx.emp.tom,
      from: '2027-03-17',
      to: '2027-03-17',
      type: 'rest_day',
    });
    const done = await call(
      ctx,
      'GET',
      `/compliance/replacement-rest?from=2027-03-01&to=2027-03-31&hotelIds=${fx.hotelA1}`,
      fx.mgrA1.token,
    );
    expect(done.body.items.find((i: any) => i.displayName === 'Tom T.')).toMatchObject({
      status: 'ok',
      restDayOn: '2027-03-17',
    });
    ctx.now.value = new Date('2027-04-20T10:00:00Z');
    const late = await call(
      ctx,
      'GET',
      `/compliance/replacement-rest?from=2027-03-01&to=2027-03-31&hotelIds=${fx.hotelA1}`,
      fx.mgrA1.token,
    );
    expect(late.body.items.find((i: any) => i.displayName === 'Maria T.')).toBeUndefined();
    ctx.now.value = new Date('2026-10-20T10:00:00Z');
  });
});

describe('feature toggles', () => {
  it('switch employee features off for a company', async () => {
    const f = await call(ctx, 'GET', `/settings/features?companyId=${fx.companyA}`, fx.mgrA1.token);
    expect(f.body.items.find((x: any) => x.feature === 'wishes').enabled).toBe(true);
    expect(
      (
        await call(ctx, 'PUT', `/settings/features?companyId=${fx.companyA}`, fx.mgrA1.token, {
          feature: 'wishes',
          enabled: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'PUT', `/settings/features?companyId=${fx.companyA}`, fx.adminB.token, {
          feature: 'wishes',
          enabled: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'PUT', `/settings/features?companyId=${fx.companyA}`, fx.adminA.token, {
          feature: 'nope',
          enabled: false,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(ctx, 'PUT', `/settings/features?companyId=${fx.companyA}`, fx.adminA.token, {
          feature: 'wishes',
          enabled: false,
        })
      ).status,
    ).toBe(200);
    expect((await call(ctx, 'GET', '/me/features', emp.maria!)).body.wishes).toBe(false);
    const off = await call(ctx, 'POST', '/me/leave-wishes', emp.maria!, {
      from: '2027-06-07',
      to: '2027-06-08',
      priority: 2,
    });
    expect(off.status).toBe(403);
    expect(off.body.error).toMatchObject({ code: 'FEATURE_DISABLED', details: { feature: 'wishes' } });
    await call(ctx, 'PUT', `/settings/features?companyId=${fx.companyA}`, fx.adminA.token, {
      feature: 'wishes',
      enabled: true,
    });
    expect(
      (
        await call(ctx, 'POST', '/me/leave-wishes', emp.maria!, {
          from: '2027-06-07',
          to: '2027-06-08',
          priority: 2,
        })
      ).status,
    ).toBe(201);
  });
});

describe('analytics', () => {
  it('summarises hours per department without per-person rankings and hides absence rates of small teams', async () => {
    const a = await call(
      ctx,
      'GET',
      `/analytics/summary?from=2026-09-01&to=2026-09-30&hotelIds=${fx.hotelA1}`,
      fx.mgrA1.token,
    );
    expect(a.status).toBe(200);
    const rez = a.body.departments.find((d: any) => d.name === 'Rezeption');
    expect(rez.actualHours).toBeGreaterThanOrEqual(14);
    expect(rez.absenceRate).toBeTypeOf('number'); // five employees
    expect(rez.timeAccountHours).toBeTypeOf('number');
    const hk = a.body.departments.find((d: any) => d.name === 'Housekeeping');
    expect(hk.absenceRate).toBeNull(); // fewer than 5 employees
    expect(a.body.approvals.buckets).toBeDefined();
    expect(a.body.openSlots).toBeTypeOf('number');
    expect(JSON.stringify(a.body)).not.toMatch(/Maria|Jon|Tom/);
    expect(
      (
        await call(
          ctx,
          'GET',
          `/analytics/summary?from=2026-09-01&to=2026-09-30&hotelIds=${fx.hotelB1}`,
          fx.mgrA1.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (await call(ctx, 'GET', '/analytics/summary?from=2026-09-30&to=2026-09-01', fx.adminA.token)).status,
    ).toBe(400);
    expect(
      (await call(ctx, 'GET', '/analytics/summary?from=2026-09-01&to=2026-09-30', emp.maria!)).status,
    ).toBe(403);
  });
});
