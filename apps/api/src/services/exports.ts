import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { eachDay, isoWeekday } from '@dienst/rules';
import type { Db } from '../db';
import { AppError } from '../lib/errors';
import { localDate } from '../lib/time';
import { formatInTimeZone } from 'date-fns-tz';
import { computeTimeAccount } from './timeAccount';

export const ABSENCE_DE: Record<string, string> = {
  annual_leave: 'Urlaub',
  sick_leave: 'Krank',
  off_day: 'Frei',
  unpaid_leave: 'Unbezahlter Urlaub',
  comp_time: 'Zeitausgleich',
  special_leave: 'Sonderurlaub',
  child_sick: 'Kind krank',
  training: 'Fortbildung',
  parental_leave: 'Elternzeit',
  maternity_leave: 'Mutterschutz',
  vocational_school: 'Berufsschule',
  rest_day: 'Ersatzruhetag',
  public_holiday: 'Feiertag',
};
const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const de = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const dm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
const num = (n: number, d = 2) =>
  n.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const hm = (d: Date | string | null, tz: string) => (d ? formatInTimeZone(new Date(d), tz, 'HH:mm') : '');

export const MONTH_DE = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];

export const monthBounds = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return {
    from: `${month}-01`,
    to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10),
    label: `${MONTH_DE[m - 1]} ${y}`,
  };
};

export async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const headStyle = (row: ExcelJS.Row) => {
  row.font = { bold: true };
  row.alignment = { vertical: 'middle', wrapText: true };
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6E6' } };
    c.border = { bottom: { style: 'medium' } };
  });
};

// ---------------------------------------------------------------------------------------------
// schedule workbook (from the grid result, so the export shows exactly what the grid shows)
export function scheduleWorkbook(grid: any, hotelNames: string[]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Dienstplan';
  const ws = wb.addWorksheet('Dienstplan', { views: [{ state: 'frozen', xSplit: 2, ySplit: 3 }] });
  const dates: string[] = grid.days.map((d: any) => d.date);
  const employeeView = grid.view === 'employee';
  ws.addRow([`Dienstplan ${de(grid.from)} – ${de(grid.to)}`]).font = { bold: true, size: 14 };
  ws.addRow([
    hotelNames.join(', '),
    grid.status === 'published' ? 'Veröffentlicht' : 'Entwurf (enthält nicht veröffentlichte Änderungen)',
  ]);
  const head = ws.addRow([
    employeeView ? 'Mitarbeitende' : 'Schicht',
    employeeView ? 'Abteilung' : 'Hotel / Abteilung',
    ...dates.map((d) => `${WD[isoWeekday(d) - 1]} ${dm(d)}`),
    employeeView ? 'Stunden' : 'Stunden',
    employeeView ? 'Soll' : 'Offen',
  ]);
  headStyle(head);
  const absOn = (empId: number, date: string) =>
    (grid.absences as any[]).filter((a) => a.employeeId === empId && a.from <= date && a.to >= date);
  const timeOf = (e: any) => `${String(e.start).slice(11, 16)}–${String(e.end).slice(11, 16)}`;
  for (const r of grid.rows as any[]) {
    if (employeeView) {
      const cells = (r.cells as any[]).map((c) => {
        const parts = (c.entries as any[]).map(
          (e) =>
            `${timeOf(e)}${e.shiftName ? ` ${e.shiftName}` : ''}${e.isOtherHotel ? ` (${e.otherHotelName})` : ''}`,
        );
        for (const a of absOn(r.employeeId, c.date))
          parts.push(`${ABSENCE_DE[a.type] ?? a.type}${a.status === 'pending' ? ' (beantragt)' : ''}`);
        return parts.join('\n');
      });
      ws.addRow([r.label, r.departmentName, ...cells, r.totalHours, r.targetHours ?? '']);
    } else {
      const cells = (r.cells as any[]).map((c) => {
        const names = (c.entries as any[]).map((e) => e.displayName).join(', ');
        return c.required != null && c.required > 0
          ? `${c.assigned}/${c.required}${names ? `\n${names}` : ''}`
          : names;
      });
      ws.addRow([
        r.label,
        `${r.hotelName}${r.departmentName ? ` / ${r.departmentName}` : ''}`,
        ...cells,
        r.totalHours,
        r.openSlots ?? '',
      ]);
    }
  }
  const totals = ws.addRow([
    'Summe Stunden',
    '',
    ...dates.map((d) => (grid.totals.perDay as any[]).find((x) => x.date === d)?.hours ?? 0),
    '',
    '',
  ]);
  totals.font = { bold: true };
  ws.getColumn(1).width = 26;
  ws.getColumn(2).width = 22;
  for (let i = 3; i < 3 + dates.length; i++) ws.getColumn(i).width = 17;
  ws.getColumn(3 + dates.length).width = 10;
  ws.getColumn(4 + dates.length).width = 10;
  ws.eachRow((row, n) => {
    if (n > 3) row.alignment = { vertical: 'top', wrapText: true };
  });
  return wb;
}

// ---------------------------------------------------------------------------------------------
// timesheet (approved records only)
export interface TimesheetData {
  employee: { id: number; name: string; personnelNumber: string | null; hotel: string; company: string };
  month: string;
  label: string;
  days: Array<{
    date: string;
    weekday: string;
    lines: Array<{ start: string; end: string; breakMinutes: number; hours: number }>;
    absence: string | null;
    hours: number;
  }>;
  totalHours: number;
  workedDays: number;
  pendingCount: number;
  absenceDays: Record<string, number>;
  targetHours: number | null;
  timeAccount: number | null;
  vacation: { used: number; remaining: number } | null;
}

export async function buildTimesheet(
  db: Db,
  employeeId: number,
  month: string,
  now: Date,
): Promise<TimesheetData> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AppError('VALIDATION', 'month must be YYYY-MM');
  const { from, to, label } = monthBounds(month);
  const e = await db
    .selectFrom('employee as e')
    .innerJoin('hotel as h', 'h.id', 'e.primary_hotel_id')
    .innerJoin('company as c', 'c.id', 'e.company_id')
    .select([
      'e.employee_id',
      'e.first_name',
      'e.last_name',
      'e.personnel_number',
      'e.primary_hotel_id',
      'h.name as hotel',
      'h.timezone',
      'c.name as company',
    ])
    .where('e.employee_id', '=', employeeId)
    .executeTakeFirstOrThrow();
  const recs = await db
    .selectFrom('punch_record as p')
    .innerJoin('hotel as h', 'h.id', 'p.hotel_id')
    .select([
      'p.shift_date',
      'p.paid_start',
      'p.paid_end',
      'p.actual_break_minutes',
      'p.paid_hours',
      'p.approval_status',
      'h.timezone',
    ])
    .where('p.employee_id', '=', employeeId)
    .where('p.shift_date', '>=', from)
    .where('p.shift_date', '<=', to)
    .where('p.actual_punch_out', 'is not', null)
    .orderBy('p.paid_start')
    .execute();
  const abs = await db
    .selectFrom('time_off')
    .select(['start_date', 'end_date', 'type'])
    .where('employee_id', '=', employeeId)
    .where('status', '=', 'approved')
    .where('start_date', '<=', to)
    .where('end_date', '>=', from)
    .execute();
  const dates = eachDay(from, to);
  const absenceDays: Record<string, number> = {};
  const days: TimesheetData['days'] = dates.map((date) => {
    const lines = recs
      .filter((r) => r.shift_date === date && r.approval_status === 'approved' && r.paid_start && r.paid_end)
      .map((r) => ({
        start: hm(r.paid_start, r.timezone),
        end: hm(r.paid_end, r.timezone),
        breakMinutes: r.actual_break_minutes ?? 0,
        hours: r.paid_hours ?? 0,
      }));
    const a = abs.find((x) => x.start_date <= date && x.end_date >= date);
    if (a) absenceDays[a.type] = (absenceDays[a.type] ?? 0) + 1;
    return {
      date,
      weekday: WD[isoWeekday(date) - 1]!,
      lines,
      absence: a ? (ABSENCE_DE[a.type] ?? a.type) : null,
      hours: Math.round(lines.reduce((s, l) => s + l.hours, 0) * 100) / 100,
    };
  });
  const contract = await db
    .selectFrom('employee_contract')
    .select(['target_hours_per_week', 'target_hours_per_month'])
    .where('employee_id', '=', employeeId)
    .where('valid_from', '<=', to)
    .orderBy('valid_from', 'desc')
    .limit(1)
    .executeTakeFirst();
  const monthly =
    contract?.target_hours_per_month ??
    (contract?.target_hours_per_week != null ? (contract.target_hours_per_week * 52) / 12 : null);
  const today = localDate(now, e.timezone);
  const year = Number(month.slice(0, 4));
  const al = await db
    .selectFrom('employee_vacation_allowance')
    .selectAll()
    .where('employee_id', '=', employeeId)
    .where('year', '=', year)
    .executeTakeFirst();
  return {
    employee: {
      id: e.employee_id,
      name: `${e.first_name} ${e.last_name}`,
      personnelNumber: e.personnel_number,
      hotel: e.hotel,
      company: e.company,
    },
    month,
    label,
    days,
    totalHours: Math.round(days.reduce((s, d) => s + d.hours, 0) * 100) / 100,
    workedDays: days.filter((d) => d.lines.length).length,
    pendingCount: recs.filter((r) => r.approval_status === 'pending').length,
    absenceDays,
    targetHours: monthly == null ? null : Math.round(monthly * 100) / 100,
    timeAccount: await computeTimeAccount(db, employeeId, today),
    vacation: al
      ? {
          used: al.used_days,
          remaining:
            al.allocated_days + al.carried_statutory_days + al.carried_contractual_days - al.used_days,
        }
      : null,
  };
}

export function timesheetWorkbook(t: TimesheetData): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Dienstplan';
  const ws = wb.addWorksheet('Stundenzettel');
  ws.addRow([`Stundenzettel ${t.label}`]).font = { bold: true, size: 14 };
  ws.addRow([
    t.employee.name,
    t.employee.personnelNumber ? `Personalnummer ${t.employee.personnelNumber}` : '',
    t.employee.hotel,
    t.employee.company,
  ]);
  ws.addRow([]);
  headStyle(ws.addRow(['Datum', 'Tag', 'Von', 'Bis', 'Pause (Min.)', 'Stunden', 'Bemerkung']));
  for (const d of t.days) {
    if (!d.lines.length && !d.absence) continue;
    if (!d.lines.length) ws.addRow([de(d.date), d.weekday, '', '', '', '', d.absence]);
    d.lines.forEach((l, i) =>
      ws.addRow([
        de(d.date),
        d.weekday,
        l.start,
        l.end,
        l.breakMinutes,
        l.hours,
        i === 0 ? (d.absence ?? '') : '',
      ]),
    );
  }
  ws.addRow([]);
  const sum = ws.addRow(['Summe', '', '', '', '', t.totalHours, `${t.workedDays} Arbeitstage`]);
  sum.font = { bold: true };
  if (t.targetHours != null) ws.addRow(['Soll', '', '', '', '', t.targetHours]);
  for (const [k, v] of Object.entries(t.absenceDays))
    ws.addRow([ABSENCE_DE[k] ?? k, '', '', '', '', '', `${v} Tage`]);
  if (t.pendingCount) ws.addRow([`Nicht enthalten: ${t.pendingCount} noch nicht freigegebene Zeiten`]);
  [12, 6, 8, 8, 12, 10, 28].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.getColumn(6).numFmt = '0.00';
  return wb;
}

export function timesheetPdf(t: TimesheetData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      info: { Title: `Stundenzettel ${t.label}`, Author: 'Dienstplan' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.font('Helvetica-Bold').fontSize(18).text(`Stundenzettel ${t.label}`);
    doc.font('Helvetica').fontSize(10).moveDown(0.3);
    doc.text(
      `${t.employee.name}${t.employee.personnelNumber ? `  ·  Personalnummer ${t.employee.personnelNumber}` : ''}`,
    );
    doc.text(`${t.employee.company}  ·  ${t.employee.hotel}`);
    doc.moveDown(0.8);
    const cols = [60, 30, 50, 50, 70, 60, 190];
    const x0 = 40;
    const row = (cells: string[], bold = false, shade = false) => {
      const y = doc.y;
      if (y > 770) {
        doc.addPage();
      }
      const yy = doc.y;
      if (shade)
        doc
          .rect(
            x0,
            yy - 2,
            cols.reduce((a, b) => a + b, 0),
            14,
          )
          .fill('#e6e6e6')
          .fillColor('#000');
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      let x = x0;
      cells.forEach((c, i) => {
        doc.text(c, x + 2, yy, {
          width: cols[i]! - 4,
          lineBreak: false,
          align: i >= 4 && i <= 5 ? 'right' : 'left',
        });
        x += cols[i]!;
      });
      doc.y = yy + 14;
    };
    row(['Datum', 'Tag', 'Von', 'Bis', 'Pause (Min.)', 'Stunden', 'Bemerkung'], true, true);
    for (const d of t.days) {
      if (!d.lines.length && !d.absence) continue;
      if (!d.lines.length) row([de(d.date), d.weekday, '', '', '', '', d.absence ?? '']);
      d.lines.forEach((l, i) =>
        row([
          de(d.date),
          d.weekday,
          l.start,
          l.end,
          String(l.breakMinutes),
          num(l.hours),
          i === 0 ? (d.absence ?? '') : '',
        ]),
      );
    }
    doc.moveDown(0.6);
    row(['Summe', '', '', '', '', num(t.totalHours), `${t.workedDays} Arbeitstage`], true, true);
    if (t.targetHours != null) row(['Soll', '', '', '', '', num(t.targetHours), '']);
    for (const [k, v] of Object.entries(t.absenceDays))
      row([ABSENCE_DE[k] ?? k, '', '', '', '', '', `${v} Tage`]);
    if (t.vacation)
      row([
        'Urlaub',
        '',
        '',
        '',
        '',
        '',
        `genommen ${num(t.vacation.used, 1)}, Rest ${num(t.vacation.remaining, 1)}`,
      ]);
    if (t.timeAccount != null)
      row([
        'Arbeitszeitkonto',
        '',
        '',
        '',
        '',
        '',
        `${t.timeAccount >= 0 ? '+' : '-'}${num(Math.abs(t.timeAccount), 1)} h`,
      ]);
    if (t.pendingCount) {
      doc
        .moveDown(0.6)
        .font('Helvetica-Oblique')
        .fontSize(9)
        .text(`Nicht enthalten: ${t.pendingCount} noch nicht freigegebene Zeiten.`, x0);
    }
    doc.moveDown(2).font('Helvetica').fontSize(9).text('Es werden nur freigegebene Zeiten ausgewiesen.', x0);
    doc.end();
  });
}
