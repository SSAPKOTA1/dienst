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
