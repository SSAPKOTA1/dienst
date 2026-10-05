import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { sql } from 'kysely';
import type { Db, Trx } from '../db';
import { AppError } from '../lib/errors';
import { audit, type Actor } from '../lib/audit';
import type { Principal } from '../lib/scope';
import { createEmployee, employeeCreateSchema, type CreatedEmployee } from './employees';

export const MAX_ROWS = 5000;
export const MAX_BYTES = 10 * 1024 * 1024;

/** The create-body fields in the order of SPEC 5.4. */
export const COLUMNS = [
  'firstName',
  'lastName',
  'dateOfBirth',
  'email',
  'primaryHotelId',
  'primaryDepartmentId',
  'hotelIds',
  'departmentIds',
  'contractStartDate',
  'contractEndDate',
  'employmentType',
  'workingModel',
  'workDaysPerWeek',
  'workingWeekdays',
  'targetHoursPerWeek',
  'targetHoursPerMonth',
  'vacationDaysPerYear',
  'vacationDaysAllocatedThisYear',
  'vacationDaysUsedThisYear',
  'monthlyHoursCap',
  'getsPublicHoliday',
] as const;
type Col = (typeof COLUMNS)[number];
const REQUIRED: Col[] = [
  'firstName',
  'lastName',
  'dateOfBirth',
  'primaryHotelId',
  'primaryDepartmentId',
  'contractStartDate',
  'employmentType',
  'workingModel',
  'workDaysPerWeek',
  'vacationDaysPerYear',
];
type Kind = 'str' | 'date' | 'int' | 'num' | 'bool' | 'ints';
const KIND: Record<Col, Kind> = {
  firstName: 'str',
  lastName: 'str',
  dateOfBirth: 'date',
  email: 'str',
  primaryHotelId: 'int',
  primaryDepartmentId: 'int',
  hotelIds: 'ints',
  departmentIds: 'ints',
  contractStartDate: 'date',
  contractEndDate: 'date',
  employmentType: 'str',
  workingModel: 'str',
  workDaysPerWeek: 'int',
  workingWeekdays: 'ints',
  targetHoursPerWeek: 'num',
  targetHoursPerMonth: 'num',
  vacationDaysPerYear: 'num',
  vacationDaysAllocatedThisYear: 'num',
  vacationDaysUsedThisYear: 'num',
  monthlyHoursCap: 'num',
  getsPublicHoliday: 'bool',
};

export interface ParsedRow {
  row: number; // Excel row number (header is row 1)
  raw: Record<string, string>;
}

/** Plain text of any ExcelJS cell value (dates as YYYY-MM-DD, formulas by their result). */
function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o) return cellText(o.result as ExcelJS.CellValue);
    if ('richText' in o) return (o.richText as Array<{ text: string }>).map((r) => r.text).join('');
    if ('text' in o) return String(o.text);
    if ('error' in o) return '';
  }
  return String(v).trim();
}

export async function parseWorkbook(buf: Buffer, fileName: string): Promise<ParsedRow[]> {
  if (!/\.xlsx$/i.test(fileName))
    throw new AppError('VALIDATION', 'Only .xlsx files are accepted (no .xlsm or .xls)', { fileName });
  if (buf.length < 4 || buf.subarray(0, 2).toString('latin1') !== 'PK')
    throw new AppError('VALIDATION', 'The file is not a valid .xlsx workbook');
  if (buf.includes('vbaProject.bin')) throw new AppError('VALIDATION', 'Workbooks with macros are rejected');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  } catch {
    throw new AppError('VALIDATION', 'The file could not be read as an .xlsx workbook');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new AppError('VALIDATION', 'The workbook has no sheet');
  const header = new Map<string, number>();
  ws.getRow(1).eachCell((c, n) => header.set(cellText(c.value).toLowerCase(), n));
  const col = (name: Col) => header.get(name.toLowerCase());
  const missing = REQUIRED.filter((c) => col(c) == null);
  if (missing.length) throw new AppError('VALIDATION', 'Required columns are missing', { missing });
  const rows: ParsedRow[] = [];
  for (let n = 2; n <= ws.rowCount; n++) {
    const r = ws.getRow(n);
    const raw: Record<string, string> = {};
    let any = false;
    for (const c of COLUMNS) {
      const idx = col(c);
      const t = idx ? cellText(r.getCell(idx).value) : '';
      raw[c] = t;
      if (t) any = true;
    }
    if (!any) continue;
    if (rows.length >= MAX_ROWS)
      throw new AppError('PAYLOAD_TOO_LARGE', `More than ${MAX_ROWS} rows`, { maxRows: MAX_ROWS });
    rows.push({ row: n, raw });
  }
  return rows;
}

const serialToIso = (n: number) => new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);

/** Coerces the text cells to the create-body types; returns the first problem per field. */
export function coerceRow(raw: Record<string, string>): {
  body: unknown;
  errors: Array<{ field: string; message: string }>;
} {
  const body: Record<string, unknown> = {};
  const errors: Array<{ field: string; message: string }> = [];
  for (const c of COLUMNS) {
    const t = (raw[c] ?? '').trim();
    if (!t) continue;
    try {
      switch (KIND[c]) {
        case 'str':
          body[c] = t;
          break;
        case 'date':
          body[c] = /^\d{5}$/.test(t)
            ? serialToIso(Number(t))
            : t.replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, '$3-$2-$1');
          break;
        case 'int':
        case 'num': {
          const n = Number(t.replace(',', '.'));
          if (!Number.isFinite(n)) throw new Error('not a number');
          body[c] = n;
          break;
        }
        case 'bool': {
          const v = t.toLowerCase();
          if (['true', 'ja', '1', 'yes', 'wahr', 'x'].includes(v)) body[c] = true;
          else if (['false', 'nein', '0', 'no', 'falsch'].includes(v)) body[c] = false;
          else throw new Error('not true/false');
          break;
        }
        case 'ints':
          body[c] = t.split(/[,;]/).map((s) => {
            const n = Number(s.trim());
            if (!Number.isInteger(n)) throw new Error('not a list of integers');
            return n;
          });
          break;
      }
    } catch (e) {
      errors.push({ field: c, message: (e as Error).message });
    }
  }
  return { body, errors };
}

// ---------------------------------------------------------------------------------------------
export type OnDuplicate = 'skip' | 'update' | 'conflict';
export interface RowResult {
  row: number;
  status: 'created' | 'updated' | 'skipped' | 'error';
  field?: string;
  code?: string;
  message?: string;
  employeeId?: number;
  personnelNumber?: string;
}
export interface Slip {
  name: string;
  username: string | null;
  personnelNumber: string;
  pin: string;
  activationMethod: string;
  activationCode?: string;
  expiresAt?: string;
}

class DryRunRollback extends Error {}

export async function runImport(
  db: Db,
  p: Principal,
  actor: Actor,
  now: Date,
  jobId: number,
  rows: ParsedRow[],
  opts: { dryRun: boolean; onDuplicate: OnDuplicate },
): Promise<{ results: RowResult[]; slips: Slip[]; mails: Array<NonNullable<CreatedEmployee['mail']>> }> {
  const results: RowResult[] = [];
  const slips: Slip[] = [];
  const mails: Array<NonNullable<CreatedEmployee['mail']>> = [];
  try {
    await db.transaction().execute(async (trx) => {
      const seen = new Set<string>();
      let i = 0;
      for (const pr of rows) {
        const sp = `imp_${i++}`;
        await sql.raw(`savepoint ${sp}`).execute(trx);
        try {
          const res = await importRow(trx, p, actor, now, pr, opts, seen);
          if (res.slip) slips.push(res.slip);
          if (res.mail) mails.push(res.mail);
          results.push(res.result);
          await sql.raw(`release savepoint ${sp}`).execute(trx);
        } catch (e) {
          await sql.raw(`rollback to savepoint ${sp}`).execute(trx);
          if (!(e instanceof AppError)) throw e; // system error: halt, roll back everything
          results.push({ row: pr.row, status: 'error', code: e.code, message: e.message });
        }
      }
      if (opts.dryRun) throw new DryRunRollback();
      const c = (s: RowResult['status']) => results.filter((r) => r.status === s).length;
      await audit(trx, actor, {
        action: 'employees_imported',
        entityType: 'import_job',
        entityId: jobId,
        new: { created: c('created'), updated: c('updated'), skipped: c('skipped'), errors: c('error') },
      });
    });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
  }
  return { results, slips: opts.dryRun ? [] : slips, mails: opts.dryRun ? [] : mails };
}

async function importRow(
  trx: Trx,
  p: Principal,
  actor: Actor,
  now: Date,
  pr: ParsedRow,
  opts: { dryRun: boolean; onDuplicate: OnDuplicate },
  seen: Set<string>,
): Promise<{ result: RowResult; slip?: Slip; mail?: CreatedEmployee['mail'] }> {
  const { body, errors } = coerceRow(pr.raw);
  if (errors.length)
    return {
      result: {
        row: pr.row,
        status: 'error',
        code: 'VALIDATION',
        field: errors[0]!.field,
        message: errors[0]!.message,
      },
    };
  const parsed = employeeCreateSchema.safeParse(body);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    return {
      result: {
        row: pr.row,
        status: 'error',
        code: 'VALIDATION',
        field: String(i.path[0] ?? ''),
        message: i.message,
      },
    };
  }
  const b = parsed.data;
  const email = b.email ? b.email.trim().toLowerCase() : null;
  if (email) {
    if (seen.has(email))
      return {
        result: {
          row: pr.row,
          status: 'error',
          code: 'DUPLICATE_IN_FILE',
          field: 'email',
          message: 'The e-mail address appears twice in the file',
        },
      };
    seen.add(email);
  }
  if (!p.scope.canHotel(b.primaryHotelId))
    return {
      result: {
        row: pr.row,
        status: 'error',
        code: 'FORBIDDEN_SCOPE',
        field: 'primaryHotelId',
        message: 'Hotel is outside your scope',
      },
    };
  if (email) {
    const dup = await trx
      .selectFrom('employee as e')
      .innerJoin('hotel as h', 'h.company_id', 'e.company_id')
      .innerJoin('user_account as u', 'u.id', 'e.user_id')
      .select(['e.employee_id', 'e.company_id'])
      .where('h.id', '=', b.primaryHotelId)
      .where(sql<boolean>`lower(u.email) = ${email}`)
      .executeTakeFirst();
    if (dup) {
      if (opts.onDuplicate === 'skip')
        return {
          result: {
            row: pr.row,
            status: 'skipped',
            code: 'DUPLICATE_EMAIL',
            field: 'email',
            message: 'An employee with this e-mail already exists',
            employeeId: dup.employee_id,
          },
        };
      if (opts.onDuplicate === 'conflict')
        return {
          result: {
            row: pr.row,
            status: 'error',
            code: 'DUPLICATE_EMAIL',
            field: 'email',
            message: 'An employee with this e-mail already exists (conflict)',
          },
        };
      await trx
        .updateTable('employee')
        .set({
          first_name: b.firstName.trim(),
          last_name: b.lastName.trim(),
          date_of_birth: b.dateOfBirth,
          updated_at: now,
        })
        .where('employee_id', '=', dup.employee_id)
        .execute();
      await audit(trx, actor, {
        action: 'employee_updated_by_import',
        entityType: 'employee',
        entityId: dup.employee_id,
        hotelId: b.primaryHotelId,
        companyId: dup.company_id,
      });
      return { result: { row: pr.row, status: 'updated', employeeId: dup.employee_id } };
    }
  }
  const c = await createEmployee(trx, p, b, now);
  await audit(trx, actor, {
    action: 'employee_created',
    entityType: 'employee',
    entityId: c.employeeId,
    hotelId: b.primaryHotelId,
    new: {
      personnelNumber: c.personnelNumber,
      userId: c.userId,
      activation: c.activation.method,
      source: 'import',
    },
  });
  return {
    result: { row: pr.row, status: 'created', employeeId: c.employeeId, personnelNumber: c.personnelNumber },
    slip: {
      name: `${b.firstName.trim()} ${b.lastName.trim()}`,
      username: c.username,
      personnelNumber: c.personnelNumber,
      pin: c.pin,
      activationMethod: c.activation.method,
      activationCode: c.activation.code,
      expiresAt: c.activation.expiresAt,
    },
    mail: c.mail,
  };
}

// ---------------------------------------------------------------------------------------------
export async function templateWorkbook(db: Db, p: Principal): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Mitarbeiter');
  const head = ws.addRow([...COLUMNS]);
  head.font = { bold: true };
  COLUMNS.forEach((c, i) => (ws.getColumn(i + 1).width = Math.max(14, c.length + 2)));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const info = wb.addWorksheet('Hinweise');
  info.addRows([
    ['Zeile 1 der Tabelle "Mitarbeiter" enthält die Spaltennamen und darf nicht geändert werden.'],
    ['Pflichtfelder: ' + REQUIRED.join(', ')],
    [
      'Datum: JJJJ-MM-TT. Listen (hotelIds, departmentIds, workingWeekdays 1=Mo..7=So) durch Komma getrennt. email darf leer sein.',
    ],
    [
      'employmentType: full_time, part_time, minijob, werkstudent, apprentice, short_term, other. workingModel: hourly oder salary.',
    ],
    ['getsPublicHoliday: true oder false.'],
    [],
    ['Hotel-ID', 'Hotel', 'Abteilungs-ID', 'Abteilung'],
  ]);
  info.getRow(7).font = { bold: true };
  info.getColumn(1).width = 60;
  const hotels = p.scope.hotelIds.length
    ? await db
        .selectFrom('hotel')
        .select(['id', 'name'])
        .where('id', 'in', p.scope.hotelIds)
        .orderBy('id')
        .execute()
    : [];
  const depts = hotels.length
    ? await db
        .selectFrom('department')
        .select(['id', 'hotel_id', 'name'])
        .where(
          'hotel_id',
          'in',
          hotels.map((h) => h.id),
        )
        .orderBy('id')
        .execute()
    : [];
  for (const h of hotels) {
    info.addRow([h.id, h.name]);
    for (const d of depts.filter((x) => x.hotel_id === h.id)) info.addRow(['', '', d.id, d.name]);
  }
  return wb;
}

export function credentialsPdf(slips: Slip[], title: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: title } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    slips.forEach((s, i) => {
      if (i > 0 && i % 4 === 0) doc.addPage();
      const y = 40 + (i % 4) * 190;
      doc.rect(40, y, 515, 175).stroke();
      doc
        .font('Helvetica-Bold')
        .fontSize(14)
        .text(s.name, 52, y + 10, { width: 490 });
      doc.font('Helvetica').fontSize(10);
      doc.text(`Personalnummer: ${s.personnelNumber}`, 52, y + 36);
      doc.text(`Benutzername: ${s.username ?? '-'}`, 52, y + 52);
      doc
        .font('Helvetica-Bold')
        .fontSize(16)
        .text(`PIN (Tablet): ${s.pin}`, 52, y + 74);
      doc.font('Helvetica').fontSize(10);
      if (s.activationCode) {
        doc.text(`Aktivierungscode: ${s.activationCode}`, 52, y + 104);
        doc.text(
          `Gültig bis: ${(s.expiresAt ?? '').slice(0, 10)}. Aktivierung unter /accept-invitation mit Benutzername und Code.`,
          52,
          y + 120,
          { width: 490 },
        );
      } else if (s.activationMethod === 'email')
        doc.text('Der Einladungslink für das Web-Konto wurde per E-Mail gesendet.', 52, y + 104, {
          width: 490,
        });
      else
        doc.text('Das vorhandene Konto wurde verknüpft; die Anmeldung bleibt unverändert.', 52, y + 104, {
          width: 490,
        });
      doc.fontSize(8).text('Bitte vertraulich behandeln. Die PIN wird nur einmal angezeigt.', 52, y + 154);
    });
    if (!slips.length) doc.text('Keine neuen Mitarbeitenden.');
    doc.end();
  });
}
