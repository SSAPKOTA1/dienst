import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { hashSecret } from '../src/lib/security';
import {
  call,
  ctxHolder,
  loginAs,
  planFixture,
  startApp,
  stopApp,
  type PlanFx,
  type TestCtx,
} from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
let maria: string;

const get = (url: string, token: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
const sheet = async (buf: Buffer, name?: string) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  return name ? wb.getWorksheet(name)! : wb.worksheets[0]!;
};
const rowsOf = (ws: ExcelJS.Worksheet) => {
  const out: string[][] = [];
  ws.eachRow((r) => out.push((r.values as any[]).slice(1).map((v) => (v == null ? '' : String(v)))));
  return out;
};

beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-20T10:00:00Z') });
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  const e = await ctx.db
    .selectFrom('employee')
    .select('user_id')
    .where('employee_id', '=', fx.emp.maria!)
    .executeTakeFirstOrThrow();
  await ctx.db
    .updateTable('user_account')
    .set({ email: 'maria@emp.test', password_hash: await hashSecret('Passw0rd!23'), status: 'active' })
    .where('id', '=', e.user_id)
    .execute();
  maria = await loginAs(ctx, 'maria@emp.test', 'employee', { employeeId: fx.emp.maria });
  // plan + publish a week for the schedule export
  await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
    hotelId: fx.hotelA1,
    employeeId: fx.emp.maria,
    shiftId: fx.early,
    date: '2026-10-26',
  });
  await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
    employeeId: fx.emp.jon,
    from: '2026-10-27',
    to: '2026-10-27',
    type: 'off_day',
  });
  // an approved and a pending record in September
  const rec = (date: string, from: string, to: string, status: string, hours: number) =>
    ctx.db
      .insertInto('punch_record')
      .values({
        employee_id: fx.emp.maria!,
        hotel_id: fx.hotelA1,
        shift_date: date,
        actual_punch_in: new Date(from),
        actual_punch_out: new Date(to),
        paid_start: new Date(from),
        paid_end: new Date(to),
        actual_break_minutes: 30,
        required_break_minutes: 30,
        paid_hours: hours,
        approval_status: status,
      } as any)
      .execute();
  await rec('2026-09-08', '2026-09-08T04:00:00Z', '2026-09-08T12:00:00Z', 'approved', 7.5);
  await rec('2026-09-09', '2026-09-09T04:00:00Z', '2026-09-09T12:00:00Z', 'pending', 7.5);
});
afterAll(async () => stopApp(ctx));

describe('schedule export', () => {
  it('returns an XLSX with German labels for both views', async () => {
    const q = `hotelIds=${fx.hotelA1}&from=2026-10-26&range=week&format=xlsx`;
    const r = await get(`/schedule/export?view=employee&${q}`, fx.mgrA1.token);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    expect(r.headers['content-disposition']).toContain('dienstplan_2026-10-26_2026-11-01.xlsx');
    const rows = rowsOf(await sheet(r.rawPayload, 'Dienstplan'));
    expect(rows[0]![0]).toBe('Dienstplan 26.10.2026 – 01.11.2026');
    expect(rows[2]!.slice(0, 4)).toEqual(['Mitarbeitende', 'Abteilung', 'Mo 26.10.', 'Di 27.10.']);
    const mariaRow = rows.find((x) => x[0] === 'Maria T.')!;
    expect(mariaRow[2]).toContain('06:00–14:00');
    expect(rows.find((x) => x[0] === 'Jon T.')![3]).toBe('Frei');
    const s = await get(`/schedule/export?view=shift&${q}`, fx.mgrA1.token);
    expect(rowsOf(await sheet(s.rawPayload, 'Dienstplan'))[2]![0]).toBe('Schicht');
  });

  it('respects the scope (other hotel 403, employee 403)', async () => {
    expect(
      (await get(`/schedule/export?hotelIds=${fx.hotelB1}&from=2026-10-26`, fx.mgrA1.token)).statusCode,
    ).toBe(403);
    expect((await get(`/schedule/export?hotelIds=${fx.hotelA1}&from=2026-10-26`, maria)).statusCode).toBe(
      403,
    );
  });
});

describe('month overview export', () => {
  const month = (token: string, m = '2026-10', hotel = fx.hotelA1) =>
    get(`/schedule/month/export?month=${m}&hotelIds=${hotel}&format=xlsx`, token);

  it('has a matrix, sums, coverage and notes; drafts are marked; managers see sickness only as "abwesend"', async () => {
    // a sick day in the past (the manager may enter it within 7 days)
    expect(
      (
        await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
          employeeId: fx.emp.tom,
          from: '2026-10-14',
          to: '2026-10-14',
          type: 'sick_leave',
        })
      ).status,
    ).toBe(201);
    const a = await month(fx.adminA.token);
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-disposition']).toContain('monatsuebersicht_2026-10.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(a.rawPayload as any);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Matrix', 'Summen', 'Besetzung', 'Hinweise']);
    const matrix = rowsOf(wb.getWorksheet('Matrix')!);
    expect(matrix[0]!.slice(0, 4)).toEqual(['Mitarbeitende', 'Hotel', 'Abteilung', 'Do 01.10.']);
    expect(matrix[0]).toHaveLength(3 + 31);
    const maria26 = matrix.find((x) => x[0] === 'Maria T.')![3 + 25]!; // 26 Oct
    expect(maria26).toContain('06:00–14:00');
    expect(maria26).toContain('(Entwurf)');
    expect(matrix.find((x) => x[0] === 'Jon T.')![3 + 26]).toBe('Frei');
    // sums: admins see the type, managers only "abwesend"
    const sumHead = rowsOf(wb.getWorksheet('Summen')!)[0]!;
    expect(sumHead).toContain('Krank (Tage)');
    const m = new ExcelJS.Workbook();
    await m.xlsx.load((await month(fx.mgrA1.token)).rawPayload as any);
    const mHead = rowsOf(m.getWorksheet('Summen')!)[0]!;
    expect(mHead).not.toContain('Krank (Tage)');
    expect(mHead).toContain('abwesend (Tage)');
    expect(JSON.stringify(rowsOf(m.getWorksheet('Matrix')!))).not.toContain('Krank');
    // coverage has a date cell per department and day
    const cover = wb.getWorksheet('Besetzung')!;
    expect(cover.getRow(1).values).toContain('Offen');
    expect(cover.rowCount).toBeGreaterThan(1);
  });

  it('respects scope, month format and is audited', async () => {
    expect((await month(fx.mgrA1.token, '2026-10', fx.hotelB1)).statusCode).toBe(403);
    expect((await month(maria)).statusCode).toBe(403);
    expect((await month(fx.adminA.token, '2026-13')).statusCode).toBe(400);
    const logged = await ctx.db
      .selectFrom('audit_log')
      .select('id')
      .where('action', '=', 'export_month_overview')
      .execute();
    expect(logged.length).toBeGreaterThan(0);
  });
});

describe('vacation overview export', () => {
  const vac = (token: string, hotel = fx.hotelA1) =>
    get(`/vacation/overview/export?year=2026&hotelIds=${hotel}&format=xlsx`, token);

  it('has the overview, every entry and notes, with numbers and dates as real cells', async () => {
    expect(
      (
        await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
          employeeId: fx.emp.maria,
          from: '2026-11-02',
          to: '2026-11-03',
          type: 'annual_leave',
        })
      ).status,
    ).toBe(201);
    const r = await vac(fx.mgrA1.token);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toContain('urlaub_2026.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.rawPayload as any);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Übersicht', 'Einträge', 'Hinweise']);
    const sum = wb.getWorksheet('Übersicht')!;
    expect((sum.getRow(1).values as any[]).slice(1, 4)).toEqual(['Mitarbeitende', 'Abteilung', 'Anspruch']);
    const row = (ws: ExcelJS.Worksheet, name: string) => {
      let found: ExcelJS.Row | undefined;
      ws.eachRow((x) => {
        if (x.getCell(1).value === name) found ??= x;
      });
      return found!;
    };
    const maria = row(sum, 'Maria T.');
    expect(typeof maria.getCell(3).value).toBe('number'); // entitlement
    expect(typeof maria.getCell(9).value).toBe('number'); // remaining
    expect(maria.getCell(9 + 11).value).toBe(2); // November (11th month column)
    const entries = wb.getWorksheet('Einträge')!;
    const e = row(entries, 'Maria T.');
    expect(e.getCell(3).value).toBeInstanceOf(Date);
    expect(e.getCell(5).value).toBe(2);
    expect(e.getCell(7).value).toBe('Genehmigt');
  });

  it('respects scope and is audited', async () => {
    expect((await vac(fx.mgrA1.token, fx.hotelB1)).statusCode).toBe(403);
    expect((await vac(maria)).statusCode).toBe(403);
    const logged = await ctx.db
      .selectFrom('audit_log')
      .select('id')
      .where('action', '=', 'export_vacation_overview')
      .execute();
    expect(logged.length).toBeGreaterThan(0);
  });
});

describe('timesheet', () => {
  it('xlsx contains approved records only and notes the pending one', async () => {
    const r = await get('/me/timesheet?month=2026-09&format=xlsx', maria);
    expect(r.statusCode).toBe(200);
    const rows = rowsOf(await sheet(r.rawPayload, 'Stundenzettel'));
    expect(rows[0]![0]).toBe('Stundenzettel September 2026');
    expect(rows.filter((x) => x[0] === '08.09.2026')).toHaveLength(1);
    expect(rows.filter((x) => x[0] === '09.09.2026')).toHaveLength(0);
    const total = rows.find((x) => x[0] === 'Summe')!;
    expect(Number(total[5])).toBe(7.5);
    expect(rows.flat().join(' ')).toContain('1 noch nicht freigegebene Zeiten');
  });

  it('shows a sick day as not worked but with its credited hours, and totals both', async () => {
    const abs = await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
      employeeId: fx.emp.maria,
      from: '2026-09-15', // Tuesday
      to: '2026-09-16',
      type: 'sick_leave',
      reason: 'entered late',
    });
    expect(abs.status, JSON.stringify(abs.body)).toBeLessThan(300);
    const r = await get('/me/timesheet?month=2026-09&format=xlsx', maria);
    const rows = rowsOf(await sheet(r.rawPayload, 'Stundenzettel'));
    const head = rows.find((x) => x[0] === 'Datum')!;
    expect(head[5]).toBe('Stunden gearbeitet');
    expect(head[6]).toBe('Stunden gutgeschrieben');
    const sick = rows.find((x) => x[0] === '15.09.2026')!;
    expect(sick[5]).toBe(''); // nothing worked
    expect(Number(sick[6])).toBeGreaterThan(0); // hours credited
    expect(sick[7]).toContain('nicht gearbeitet');
    const total = rows.find((x) => x[0] === 'Summe')!;
    const all = rows.find((x) => x[0] === 'Gesamt')!;
    expect(Number(total[5])).toBe(7.5); // worked hours are unchanged
    expect(Number(total[6])).toBeCloseTo(Number(sick[6]) * 2);
    expect(Number(all[5])).toBeCloseTo(7.5 + Number(total[6]));
    await ctx.db
      .deleteFrom('time_off')
      .where('employee_id', '=', fx.emp.maria!)
      .where('type', '=', 'sick_leave')
      .execute();
  });

  it('pdf downloads for the employee and for a planner of the home hotel', async () => {
    const me = await get('/me/timesheet?month=2026-09', maria);
    expect(me.statusCode).toBe(200);
    expect(me.headers['content-type']).toBe('application/pdf');
    expect(me.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    const pl = await get(`/timesheets?employeeId=${fx.emp.maria}&month=2026-09&format=pdf`, fx.mgrA1.token);
    expect(pl.statusCode).toBe(200);
    expect(pl.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('scope and validation', async () => {
    expect(
      (await get(`/timesheets?employeeId=${fx.emp.maria}&month=2026-09`, fx.mgrA2.token)).statusCode,
    ).toBe(403);
    expect(
      (await get(`/timesheets?employeeId=${fx.emp.maria}&month=2026-09`, fx.adminB.token)).statusCode,
    ).toBe(403);
    expect((await get(`/timesheets?employeeId=${fx.emp.maria}&month=2026-09`, maria)).statusCode).toBe(403);
    expect((await get('/me/timesheet?month=2026-13', maria)).statusCode).toBe(400);
    expect((await get('/me/timesheet?month=2026-09', fx.adminA.token)).statusCode).toBe(403);
  });
});
