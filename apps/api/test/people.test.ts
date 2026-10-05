import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOffboarding, runReminders } from '../src/services/reminders';
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

const upload = (
  url: string,
  token: string,
  file: Buffer,
  fields: Record<string, string>,
  name = 'doc.pdf',
) => {
  const b = '----dienstDocBoundary';
  const parts = Object.entries(fields).map(
    ([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
  );
  const body = Buffer.concat([
    Buffer.from(parts.join('')),
    Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return ctx.app
    .inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${b}` },
      payload: body,
    })
    .then((r) => ({ status: r.statusCode, body: r.json() as any }));
};
const get = (url: string, token: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\nSECRET-CONTENT-123');

beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-20T10:00:00Z') });
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  emp = await employeeTokens(ctx, fx, ['maria', 'jon', 'tom']);
});
afterAll(async () => stopApp(ctx));

describe('qualifications', () => {
  it('are defined by admins, assigned by planners and warn when a shift requires one', async () => {
    expect((await call(ctx, 'POST', '/qualifications', fx.mgrA1.token, { name: 'Ersthelfer' })).status).toBe(
      403,
    );
    const q = await call(ctx, 'POST', '/qualifications', fx.adminA.token, {
      name: 'Ersthelfer',
      hasExpiry: true,
    });
    expect(q.status).toBe(201);
    expect((await call(ctx, 'POST', '/qualifications', fx.adminA.token, { name: 'Ersthelfer' })).status).toBe(
      409,
    );
    expect((await call(ctx, 'GET', '/qualifications', fx.mgrA1.token)).body.items).toHaveLength(1);
    expect((await call(ctx, 'GET', '/qualifications', fx.adminB.token)).body.items).toEqual([]);
    // shift requiring it
    const sh = await call(ctx, 'POST', '/shifts', fx.adminA.token, {
      hotelId: fx.hotelA1,
      departmentId: fx.deptA1,
      name: 'Nachtportier',
      startTime: '23:00',
      endTime: '07:00',
      breakMinutes: 30,
      requiredQualificationId: q.body.id,
    });
    expect(sh.status).toBe(201);
    expect(sh.body.requiredQualificationId).toBe(q.body.id);
    expect(
      (
        await call(ctx, 'POST', '/shifts', fx.adminB.token, {
          hotelId: fx.hotelB1,
          departmentId: fx.deptB1,
          name: 'X',
          startTime: '08:00',
          endTime: '12:00',
          requiredQualificationId: q.body.id,
        })
      ).status,
    ).toBe(400);
    const e1 = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.maria,
      shiftId: sh.body.id,
      date: '2027-02-01',
    });
    expect(e1.body.warnings.find((w: any) => w.code === 'QUALIFICATION_MISSING')).toMatchObject({
      severity: 'warn',
      details: { expired: false },
    });
    // an expiring qualification needs a date, then the warning is gone, then it expires
    expect(
      (
        await call(ctx, 'PUT', `/employees/${fx.emp.maria}/qualifications`, fx.mgrA1.token, {
          items: [{ qualificationId: q.body.id }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(ctx, 'PUT', `/employees/${fx.emp.maria}/qualifications`, fx.mgrA2.token, {
          items: [{ qualificationId: q.body.id, validUntil: '2027-12-31' }],
        })
      ).status,
    ).toBe(403);
    const set = await call(ctx, 'PUT', `/employees/${fx.emp.maria}/qualifications`, fx.mgrA1.token, {
      items: [{ qualificationId: q.body.id, validUntil: '2027-02-15' }],
    });
    expect(set.body.items[0]).toMatchObject({ name: 'Ersthelfer', validUntil: '2027-02-15' });
    expect((await call(ctx, 'GET', '/me/qualifications', emp.maria!)).body.items).toHaveLength(1);
    const e2 = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.maria,
      shiftId: sh.body.id,
      date: '2027-02-09',
    });
    expect(e2.body.warnings.map((w: any) => w.code)).not.toContain('QUALIFICATION_MISSING');
    const e3 = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.maria,
      shiftId: sh.body.id,
      date: '2027-02-23',
    });
    expect(e3.body.warnings.find((w: any) => w.code === 'QUALIFICATION_MISSING')).toMatchObject({
      details: { expired: true },
    });
    // cannot delete while in use
    expect((await call(ctx, 'DELETE', `/qualifications/${q.body.id}`, fx.adminA.token)).status).toBe(409);
    expect(
      (
        await call(ctx, 'PUT', `/qualifications/${q.body.id}`, fx.adminA.token, {
          name: 'Ersthelfer/in',
          hasExpiry: true,
        })
      ).body.name,
    ).toBe('Ersthelfer/in');
  });

  it('expiry reminders reach the admins 30 and 7 days before, once', async () => {
    ctx.now.value = new Date('2027-01-16T10:00:00Z'); // 30 days before 2027-02-15
    expect(await runReminders(ctx.db, ctx.now.value)).toBeGreaterThan(0);
    expect(await runReminders(ctx.db, ctx.now.value)).toBe(0); // deduplicated
    const n = await ctx.db
      .selectFrom('notification')
      .select(['kind', 'payload'])
      .where('kind', '=', 'qualification_expiring')
      .execute();
    expect(n).toHaveLength(1);
    expect((n[0]!.payload as any).qualification).toBe('Ersthelfer/in');
    ctx.now.value = new Date('2027-02-08T10:00:00Z');
    expect(await runReminders(ctx.db, ctx.now.value)).toBeGreaterThan(0);
    const exp = await call(ctx, 'GET', '/documents/expiring?days=60', fx.adminA.token);
    expect(exp.body.qualifications[0]).toMatchObject({ displayName: 'Maria T.', expired: false });
    ctx.now.value = new Date('2026-10-20T10:00:00Z');
  });
});

describe('availability', () => {
  it('"cannot work" windows need a reason when planned into; preferred windows are only data', async () => {
    // 2027-03-02 is a Tuesday (weekday 2)
    const a = await call(ctx, 'POST', '/me/availability', emp.jon!, {
      weekday: 2,
      from: '13:00',
      to: '23:00',
      kind: 'unavailable',
      note: 'Abendkurs',
    });
    expect(a.status).toBe(201);
    expect(
      (
        await call(ctx, 'POST', '/me/availability', emp.jon!, {
          weekday: 2,
          from: '13:00',
          to: '12:00',
          kind: 'unavailable',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(ctx, 'POST', '/me/availability', emp.jon!, {
          weekday: 3,
          from: '08:00',
          to: '12:00',
          kind: 'preferred',
        })
      ).status,
    ).toBe(201);
    const need = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.late,
      date: '2027-03-02',
    });
    expect(need.status).toBe(422);
    expect(need.body.error).toMatchObject({ code: 'REASON_REQUIRED' });
    expect(need.body.error.details.violations[0]).toMatchObject({
      code: 'UNAVAILABLE',
      details: { note: 'Abendkurs' },
    });
    expect(
      (
        await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
          hotelId: fx.hotelA1,
          employeeId: fx.emp.jon,
          shiftId: fx.late,
          date: '2027-03-02',
          overrideReason: 'Personalmangel',
        })
      ).status,
    ).toBe(201);
    // outside the window and on the preferred day: no objection
    expect(
      (
        await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
          hotelId: fx.hotelA1,
          employeeId: fx.emp.jon,
          shiftId: fx.early,
          date: '2027-03-02',
          overrideReason: 'Test reason',
        })
      ).status,
    ).toBe(422); // overlap with the late shift
    const ok = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.early,
      date: '2027-03-04',
    });
    expect(ok.status).toBe(201);
    const list = await call(ctx, 'GET', `/availability?hotelIds=${fx.hotelA1}`, fx.mgrA1.token);
    expect(list.body.items.map((i: any) => i.kind).sort()).toEqual(['preferred', 'unavailable']);
    expect((await call(ctx, 'GET', `/availability?hotelIds=${fx.hotelA2}`, fx.mgrA1.token)).status).toBe(403);
    expect((await call(ctx, 'DELETE', `/me/availability/${a.body.id}`, emp.tom!)).status).toBe(404);
    expect((await call(ctx, 'DELETE', `/me/availability/${a.body.id}`, emp.jon!)).status).toBe(204);
    expect((await call(ctx, 'GET', '/me/availability', emp.jon!)).body.items).toHaveLength(1);
    await call(ctx, 'PUT', `/settings/features?companyId=${fx.companyA}`, fx.adminA.token, {
      feature: 'availability',
      enabled: false,
    });
    expect((await call(ctx, 'GET', '/me/availability', emp.jon!)).status).toBe(403);
    await call(ctx, 'PUT', `/settings/features?companyId=${fx.companyA}`, fx.adminA.token, {
      feature: 'availability',
      enabled: true,
    });
  });
});

describe('documents', () => {
  it('are stored encrypted, shown to the employee only when visible and every download is logged', async () => {
    const up = await upload(
      `/employees/${fx.emp.tom}/documents`,
      fx.adminA.token,
      PDF,
      { title: 'Arbeitsvertrag', docType: 'contract', validUntil: '2027-06-30', visibleToEmployee: 'true' },
      'Vertrag Tom.pdf',
    );
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({
      docType: 'contract',
      mime: 'application/pdf',
      sizeBytes: PDF.length,
      visibleToEmployee: true,
    });
    const hidden = await upload(`/employees/${fx.emp.tom}/documents`, fx.adminA.token, PDF, {
      title: 'Interne Notiz',
      docType: 'other',
      visibleToEmployee: 'false',
    });
    const row = await ctx.db
      .selectFrom('employee_document')
      .select('content_enc')
      .where('id', '=', up.body.id)
      .executeTakeFirstOrThrow();
    expect(row.content_enc.includes(Buffer.from('SECRET-CONTENT-123'))).toBe(false);
    const dl = await get(`/documents/${up.body.id}/download`, fx.adminA.token);
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(PDF)).toBe(true);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['cache-control']).toBe('no-store');
    const mine = await call(ctx, 'GET', '/me/documents', emp.tom!);
    expect(mine.body.items.map((d: any) => d.title)).toEqual(['Arbeitsvertrag']);
    expect((await get(`/me/documents/${up.body.id}/download`, emp.tom!)).statusCode).toBe(200);
    expect((await get(`/me/documents/${hidden.body.id}/download`, emp.tom!)).statusCode).toBe(404);
    expect((await get(`/me/documents/${up.body.id}/download`, emp.jon!)).statusCode).toBe(404);
    const acts = await ctx.db
      .selectFrom('audit_log')
      .select('action')
      .where('entity_type', '=', 'employee_document')
      .execute();
    expect(acts.filter((a) => a.action === 'document_downloaded')).toHaveLength(2);
    expect(acts.map((a) => a.action)).toContain('document_uploaded');
    // listing and scope
    expect(
      (await call(ctx, 'GET', `/employees/${fx.emp.tom}/documents`, fx.adminA.token)).body.items,
    ).toHaveLength(2);
    expect((await call(ctx, 'GET', `/employees/${fx.emp.tom}/documents`, fx.mgrA1.token)).status).toBe(403);
    expect((await call(ctx, 'GET', `/employees/${fx.emp.tom}/documents`, fx.adminB.token)).status).toBe(403);
    expect((await get(`/documents/${up.body.id}/download`, fx.adminB.token)).statusCode).toBe(403);
    const exp = await call(ctx, 'GET', '/documents/expiring?days=365', fx.adminA.token);
    expect(exp.body.documents.map((d: any) => d.title)).toEqual(['Arbeitsvertrag']);
    expect((await call(ctx, 'DELETE', `/documents/${hidden.body.id}`, fx.adminA.token)).status).toBe(204);
  });

  it('rejects other file types, files with the wrong content and oversize files', async () => {
    const bad = (buf: Buffer, name = 'x.pdf') =>
      upload(
        `/employees/${fx.emp.tom}/documents`,
        fx.adminA.token,
        buf,
        { title: 'T', docType: 'other' },
        name,
      );
    expect((await bad(Buffer.from('MZ\x90\x00 executable'))).status).toBe(400);
    expect((await bad(Buffer.from('<html>'), 'x.html')).status).toBe(400);
    expect((await bad(Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)]))).status).toBe(413);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('rest')]);
    expect((await bad(png, 'scan.png')).body.mime).toBe('image/png');
    expect(
      (await upload(`/employees/${fx.emp.tom}/documents`, fx.adminA.token, PDF, { docType: 'other' })).status,
    ).toBe(400); // title missing
    expect(
      (
        await upload(`/employees/${fx.emp.tom}/documents`, fx.adminA.token, PDF, {
          title: 'T',
          docType: 'diagnosis',
        })
      ).status,
    ).toBe(400); // no health documents
  });
});

describe('offboarding', () => {
  it('terminate sets the end date, stops planning, produces the exit statement and later switches the login off', async () => {
    await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.early,
      date: '2026-12-02',
    });
    await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.early,
      date: '2026-12-16',
    });
    await call(ctx, 'POST', '/schedule/publish', fx.adminA.token, {
      hotelIds: [fx.hotelA1],
      from: '2026-12-01',
      to: '2026-12-31',
    });
    expect(
      (
        await call(ctx, 'POST', `/employees/${fx.emp.jon}/terminate`, fx.mgrA1.token, {
          lastDay: '2026-12-10',
        })
      ).status,
    ).toBe(403);
    const t = await call(ctx, 'POST', `/employees/${fx.emp.jon}/terminate`, fx.adminA.token, {
      lastDay: '2026-12-10',
      reason: 'Kündigung',
    });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({
      lastDay: '2026-12-10',
      reason: 'Kündigung',
      vacation: { year: 2026 },
      open: { plannedShiftsAfterLastDay: 0 },
    });
    expect(t.body.vacation.payoutDays).toBeGreaterThan(0);
    const e = await ctx.db
      .selectFrom('employee')
      .select(['contract_end_date', 'status'])
      .where('employee_id', '=', fx.emp.jon!)
      .executeTakeFirstOrThrow();
    expect(e).toEqual({ contract_end_date: '2026-12-10', status: 'active' });
    const rows = await ctx.db
      .selectFrom('schedule')
      .select(['shift_date', 'status'])
      .where('employee_id', '=', fx.emp.jon!)
      .orderBy('shift_date')
      .execute();
    expect(rows).toEqual([
      { shift_date: '2026-12-02', status: 'published' },
      { shift_date: '2026-12-16', status: 'cancelled' },
    ]);
    const after = await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.early,
      date: '2026-12-17',
    });
    expect(after.status).toBe(422);
    expect(after.body.error.details.violations[0].code).toBe('CONTRACT_INACTIVE');
    expect(
      (await call(ctx, 'GET', `/employees/${fx.emp.jon}/exit-statement`, fx.adminA.token)).body.lastDay,
    ).toBe('2026-12-10');
    expect(
      (
        await call(ctx, 'POST', `/employees/${fx.emp.jon}/terminate`, fx.adminA.token, {
          lastDay: '2026-12-11',
        })
      ).status,
    ).toBe(200); // may be moved while active
    // alerts before the end, deactivation after it
    ctx.now.value = new Date('2026-11-30T10:00:00Z'); // 11 days before
    expect(await runReminders(ctx.db, ctx.now.value)).toBeGreaterThan(0);
    expect(
      (await ctx.db.selectFrom('notification').select('kind').where('kind', '=', 'contract_ending').execute())
        .length,
    ).toBeGreaterThan(0);
    expect(await runOffboarding(ctx.db, ctx.now.value)).toBe(0);
    ctx.now.value = new Date('2026-12-12T10:00:00Z');
    expect(await runOffboarding(ctx.db, ctx.now.value)).toBe(1);
    const gone = await ctx.db
      .selectFrom('employee as e')
      .innerJoin('user_account as u', 'u.id', 'e.user_id')
      .select(['e.status', 'u.status as ustatus'])
      .where('e.employee_id', '=', fx.emp.jon!)
      .executeTakeFirstOrThrow();
    expect(gone).toEqual({ status: 'inactive', ustatus: 'disabled' });
    expect((await call(ctx, 'GET', '/me/home', emp.jon!)).status).toBe(401);
    expect(
      (
        await call(ctx, 'POST', `/employees/${fx.emp.jon}/terminate`, fx.adminA.token, {
          lastDay: '2026-12-20',
        })
      ).status,
    ).toBe(409);
    ctx.now.value = new Date('2026-10-20T10:00:00Z');
  });

  it('a last day in the past deactivates at once', async () => {
    const r = await call(ctx, 'POST', `/employees/${fx.emp.maria}/terminate`, fx.adminA.token, {
      lastDay: '2026-10-01',
    });
    expect(r.status).toBe(200);
    expect(
      (
        await ctx.db
          .selectFrom('employee')
          .select('status')
          .where('employee_id', '=', fx.emp.maria!)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('inactive');
  });
});
