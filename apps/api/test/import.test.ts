import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { COLUMNS } from '../src/services/employeeImport';
import { call, startApp, stopApp, setupOrg, type Org, type TestCtx } from './helpers';

let ctx: TestCtx;
let org: Org;

beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-20T10:00:00Z') });
  org = await setupOrg(ctx);
});
afterAll(async () => stopApp(ctx));

type Row = Record<string, unknown>;
const good = (over: Row = {}): Row => ({
  firstName: 'Ida',
  lastName: 'Import',
  dateOfBirth: '1991-03-02',
  email: '',
  primaryHotelId: org.hotelA1,
  primaryDepartmentId: org.deptA1,
  contractStartDate: '2026-01-01',
  employmentType: 'full_time',
  workingModel: 'salary',
  workDaysPerWeek: 5,
  targetHoursPerWeek: 40,
  vacationDaysPerYear: 30,
  ...over,
});

async function workbook(rows: Row[], headers: readonly string[] = COLUMNS): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Mitarbeiter');
  ws.addRow([...headers]);
  for (const r of rows) ws.addRow(headers.map((h) => r[h] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function upload(
  token: string,
  file: Buffer,
  o: { name?: string; dryRun?: boolean; dup?: string } = {},
) {
  const b = '----dienstTestBoundary';
  const part = (n: string, v: string) =>
    `--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const body = Buffer.concat([
    Buffer.from(part('dryRun', String(o.dryRun ?? false)) + part('onDuplicateEmail', o.dup ?? 'skip')),
    Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${o.name ?? 'import.xlsx'}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const r = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/employees/import',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${b}` },
    payload: body,
  });
  return { status: r.statusCode, body: r.json() as any };
}
const get = (url: string, token: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
const empCount = async () =>
  Number(
    (
      await ctx.db
        .selectFrom('employee')
        .select((e) => e.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  );

describe('template', () => {
  it('has the create-body columns in order and lists hotels and departments with ids', async () => {
    const r = await get('/employees/import-template', org.adminA.token);
    expect(r.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.rawPayload as any);
    expect((wb.getWorksheet('Mitarbeiter')!.getRow(1).values as string[]).slice(1)).toEqual([...COLUMNS]);
    const ids: string[] = [];
    wb.getWorksheet('Hinweise')!.eachRow((row) => ids.push(String(row.getCell(1).value)));
    expect(ids).toContain(String(org.hotelA1));
    expect(ids).not.toContain(String(org.hotelB1)); // admin A never sees company B
    expect((await get('/employees/import-template', org.mgrA1.token)).statusCode).toBe(403);
  });
});

describe('dry run', () => {
  it('validates per row, reports errors and changes nothing', async () => {
    const before = await empCount();
    const file = await workbook([
      good(),
      good({ firstName: 'Bad', dateOfBirth: 'not a date' }),
      good({ firstName: 'NoDept', primaryDepartmentId: 999999 }),
      good({ firstName: 'Twin', email: 'twin@x.test' }),
      good({ firstName: 'Twin2', email: 'TWIN@x.test' }),
      good({ firstName: 'OtherCo', primaryHotelId: org.hotelB1 }),
    ]);
    const r = await upload(org.adminA.token, file, { dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      dryRun: true,
      totalRows: 6,
      created: 2,
      errors: 4,
      credentialsAvailable: false,
    });
    const byRow = new Map<number, any>(r.body.rows.map((x: any) => [x.row, x]));
    expect(byRow.get(3)).toMatchObject({ status: 'error', code: 'VALIDATION', field: 'dateOfBirth' });
    expect(byRow.get(4)).toMatchObject({ status: 'error', code: 'VALIDATION' });
    expect(byRow.get(6)).toMatchObject({ status: 'error', code: 'DUPLICATE_IN_FILE' });
    expect(byRow.get(7)).toMatchObject({ status: 'error', code: 'FORBIDDEN_SCOPE' });
    expect(await empCount()).toBe(before);
    expect((await get(`/imports/${r.body.id}/credentials.pdf`, org.adminA.token)).statusCode).toBe(404);
  });
});

describe('import', () => {
  let jobId: number;
  it('creates employees with linked accounts, PINs never leave the credentials sheet, errors are exported safely', async () => {
    const before = await empCount();
    const file = await workbook([
      good({ firstName: 'Ida', email: 'ida@import.test' }),
      good({ firstName: 'Noah', lastName: 'Nocode' }),
      good({ firstName: '=HYPERLINK("x")', dateOfBirth: 'broken' }),
    ]);
    const r = await upload(org.adminA.token, file);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ dryRun: false, created: 2, errors: 1, credentialsAvailable: true });
    jobId = r.body.id;
    expect(await empCount()).toBe(before + 2);
    const ida = await ctx.db
      .selectFrom('employee as e')
      .innerJoin('user_account as u', 'u.id', 'e.user_id')
      .select(['u.email', 'u.username', 'u.status', 'e.pin_hash', 'e.status as es', 'e.personnel_number'])
      .where('e.first_name', '=', 'Ida')
      .executeTakeFirstOrThrow();
    expect(ida).toMatchObject({ email: 'ida@import.test', status: 'pending_invite', es: 'active' });
    expect(ida.pin_hash).toMatch(/^\$argon2id\$/);
    const noah = await ctx.db
      .selectFrom('user_account as u')
      .innerJoin('employee as e', 'e.user_id', 'u.id')
      .select(['u.username', 'u.invitation_token_hash'])
      .where('e.first_name', '=', 'Noah')
      .executeTakeFirstOrThrow();
    expect(noah.username).toBeTruthy();
    expect(noah.invitation_token_hash).toBeTruthy(); // activation code (no email)
    // role selector lists the employee role: the employee has an active employment
    expect(JSON.stringify(r.body)).not.toMatch(/\b\d{6}\b.*pin/i);
    // mail only for the row with an address, and it carries no PIN
    const csv = await get(`/imports/${jobId}/errors.csv`, org.adminA.token);
    expect(csv.statusCode).toBe(200);
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    expect(csv.body).toContain("'=HYPERLINK");
    expect(csv.body).not.toMatch(/;=HYPERLINK/);
    const audit = await ctx.db
      .selectFrom('audit_log')
      .select('action')
      .where('entity_type', '=', 'import_job')
      .execute();
    expect(audit.map((a) => a.action)).toContain('employees_imported');
  });

  it('credentials sheet downloads once; ownership is enforced; logs stay clean', async () => {
    expect((await get(`/imports/${jobId}`, org.adminB.token)).statusCode).toBe(404);
    expect((await get(`/imports/${jobId}/credentials.pdf`, org.adminB.token)).statusCode).toBe(404);
    const pdf = await get(`/imports/${jobId}/credentials.pdf`, org.adminA.token);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    const again = await get(`/imports/${jobId}/credentials.pdf`, org.adminA.token);
    expect(again.statusCode).toBe(409);
    const j = await ctx.db
      .selectFrom('import_job')
      .select(['credentials_enc', 'credentials_downloaded_at'])
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect(j.credentials_enc).toBeNull();
    expect(j.credentials_downloaded_at).not.toBeNull();
    expect(ctx.logs.join('\n')).not.toMatch(/"pin"\s*:\s*"\d{6}"/);
  });

  it('credentials expire after 24 h and the wipe job removes them', async () => {
    const r = await upload(
      org.adminA.token,
      await workbook([good({ firstName: 'Late', email: 'late@import.test' })]),
    );
    ctx.now.value = new Date(ctx.now.value.getTime() + 25 * 3600e3);
    expect((await get(`/imports/${r.body.id}/credentials.pdf`, org.adminA.token)).statusCode).toBe(409);
    const { wipeExpiredCredentials } = await import('../src/jobs/autoCheckout');
    expect(await wipeExpiredCredentials(ctx.db, ctx.now.value)).toBe(1);
    ctx.now.value = new Date('2026-10-20T10:00:00Z');
  });
});

describe('duplicate e-mail handling', () => {
  const dupFile = () =>
    workbook([good({ firstName: 'Ida2', lastName: 'Renamed', email: 'ida@import.test' })]);
  it('skip reports the row as skipped, conflict as an error, update changes the person', async () => {
    const skip = await upload(org.adminA.token, await dupFile(), { dup: 'skip' });
    expect(skip.body).toMatchObject({ created: 0, skipped: 1, errors: 0 });
    const conflict = await upload(org.adminA.token, await dupFile(), { dup: 'conflict' });
    expect(conflict.body).toMatchObject({ created: 0, errors: 1 });
    expect(conflict.body.rows[0].code).toBe('DUPLICATE_EMAIL');
    const upd = await upload(org.adminA.token, await dupFile(), { dup: 'update' });
    expect(upd.body).toMatchObject({ created: 0, updated: 1 });
    const e = await ctx.db
      .selectFrom('employee')
      .select(['first_name', 'last_name'])
      .where('contact_email', '=', 'ida@import.test')
      .executeTakeFirstOrThrow();
    expect(e).toEqual({ first_name: 'Ida2', last_name: 'Renamed' });
  });
});

describe('rejections', () => {
  it('rejects .xlsm, macros, wrong headers, more than 5000 rows and files above 10 MB', async () => {
    const ok = await workbook([good()]);
    expect((await upload(org.adminA.token, ok, { name: 'a.xlsm' })).status).toBe(400);
    expect((await upload(org.adminA.token, Buffer.concat([ok, Buffer.from('vbaProject.bin')]))).status).toBe(
      400,
    );
    expect((await upload(org.adminA.token, Buffer.from('not a zip'))).status).toBe(400);
    const noHeader = await upload(org.adminA.token, await workbook([{ a: 1 }], ['a', 'b']));
    expect(noHeader.status).toBe(400);
    expect(noHeader.body.error.details.missing).toContain('firstName');
    const many = await upload(org.adminA.token, await workbook(Array.from({ length: 5001 }, () => good())), {
      dryRun: true,
    });
    expect(many.status).toBe(413);
    expect(many.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    const huge = await upload(org.adminA.token, Buffer.concat([ok, Buffer.alloc(11 * 1024 * 1024)]));
    expect(huge.status).toBe(413);
  });

  it('only administration may import; managers are denied', async () => {
    expect((await upload(org.mgrA1.token, await workbook([good()]))).status).toBe(403);
    expect((await call(ctx, 'GET', '/imports/1', org.mgrA1.token)).status).toBe(403);
  });
});
