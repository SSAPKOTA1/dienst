import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { idParam } from '../lib/http';
import { toCsv } from '../lib/csv';
import { sendInvitationMail } from '../services/accounts';
import {
  COLUMNS,
  MAX_BYTES,
  credentialsPdf,
  parseWorkbook,
  runImport,
  templateWorkbook,
  type OnDuplicate,
  type RowResult,
  type Slip,
} from '../services/employeeImport';
import { toBuffer } from '../services/exports';

const admins = requireRole('superAdmin', 'admin');
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CREDENTIAL_HOURS = 24;

export async function importRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  r.get('/employees/import-template', { preValidation: admins }, async (req, reply) => {
    const wb = await templateWorkbook(db, getPrincipal(req));
    return reply
      .header('content-type', XLSX)
      .header('content-disposition', 'attachment; filename="mitarbeiter-import-vorlage.xlsx"')
      .send(await toBuffer(wb));
  });

  r.post('/employees/import', { preValidation: admins }, async (req, reply) => {
    const p = getPrincipal(req);
    if (!req.isMultipart())
      throw new AppError('VALIDATION', 'Send the workbook as multipart/form-data (field "file")');
    const fields: Record<string, string> = {};
    let file: { buf: Buffer; name: string; truncated: boolean } | null = null;
    for await (const part of req.parts({ limits: { fileSize: MAX_BYTES, files: 1 } })) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        if (part.fieldname === 'file')
          file = { buf, name: part.filename ?? '', truncated: part.file.truncated };
      } else fields[part.fieldname] = String(part.value);
    }
    if (!file) throw new AppError('VALIDATION', 'Field "file" is missing');
    if (file.truncated)
      throw new AppError('PAYLOAD_TOO_LARGE', 'The file is larger than 10 MB', { maxBytes: MAX_BYTES });
    const q = req.query as Record<string, string | undefined>;
    const opts = z
      .object({
        dryRun: z.enum(['true', 'false']).default('false'),
        onDuplicateEmail: z.enum(['skip', 'update', 'conflict']).default('skip'),
      })
      .parse({
        dryRun: fields.dryRun ?? q.dryRun,
        onDuplicateEmail: fields.onDuplicateEmail ?? q.onDuplicateEmail,
      });
    const dryRun = opts.dryRun === 'true';
    const onDuplicate = opts.onDuplicateEmail as OnDuplicate;
    const rows = await parseWorkbook(file.buf, file.name);
    const now = app.clock();
    const job = await db
      .insertInto('import_job')
      .values({
        import_type: 'employees',
        admin_id: p.adminId,
        created_by_user_id: p.userId,
        file_name: file.name.slice(0, 255),
        status: 'running',
        dry_run: dryRun,
        on_duplicate_email: onDuplicate,
        total_rows: rows.length,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    let out;
    try {
      out = await runImport(db, p, actorOf(req), now, job.id, rows, { dryRun, onDuplicate });
    } catch (e) {
      await db
        .updateTable('import_job')
        .set({ status: 'failed', finished_at: app.clock() })
        .where('id', '=', job.id)
        .execute();
      throw e;
    }
    const count = (s: RowResult['status']) => out.results.filter((x) => x.status === s).length;
    const rawErrors: Record<number, Record<string, string>> = {};
    for (const x of out.results)
      if (x.status === 'error') rawErrors[x.row] = rows.find((y) => y.row === x.row)!.raw;
    await db
      .updateTable('import_job')
      .set({
        status: 'done',
        created_count: count('created'),
        updated_count: count('updated'),
        skipped_count: count('skipped'),
        error_count: count('error'),
        result: JSON.stringify(out.results),
        raw_rows: JSON.stringify(rawErrors),
        finished_at: app.clock(),
        ...(out.slips.length
          ? {
              credentials_enc: app.keys.seal('import-credentials', JSON.stringify(out.slips)),
              credentials_expires_at: new Date(now.getTime() + CREDENTIAL_HOURS * 3600e3),
            }
          : {}),
      })
      .where('id', '=', job.id)
      .execute();
    if (dryRun)
      await audit(db, actorOf(req), {
        action: 'employee_import_dry_run',
        entityType: 'import_job',
        entityId: job.id,
        new: { rows: rows.length, errors: count('error') },
      });
    for (const m of out.mails) await sendInvitationMail(app, m.to, m.name, m.token);
    return reply.status(dryRun ? 200 : 201).send(await summary(job.id));
  });

  const load = async (p: ReturnType<typeof getPrincipal>, id: number) => {
    const j = await db.selectFrom('import_job').selectAll().where('id', '=', id).executeTakeFirst();
    if (!j || (p.role !== 'superAdmin' && j.created_by_user_id !== p.userId)) throw notFound('Import');
    return j;
  };
  async function summary(id: number) {
    const j = await db.selectFrom('import_job').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const results = (j.result ?? []) as unknown as RowResult[];
    const active =
      !!j.credentials_enc && !!j.credentials_expires_at && j.credentials_expires_at > app.clock();
    return {
      id: j.id,
      status: j.status,
      dryRun: j.dry_run,
      fileName: j.file_name,
      onDuplicateEmail: j.on_duplicate_email,
      totalRows: j.total_rows,
      created: j.created_count ?? 0,
      updated: j.updated_count ?? 0,
      skipped: j.skipped_count ?? 0,
      errors: j.error_count ?? 0,
      rows: results.slice(0, 500),
      credentialsAvailable: active,
      credentialsExpiresAt: active ? j.credentials_expires_at!.toISOString() : null,
    };
  }

  r.get('/imports/:id', { preValidation: admins, schema: { params: idParam } }, async (req) => {
    await load(getPrincipal(req), req.params.id);
    return summary(req.params.id);
  });

  r.get(
    '/imports/:id/errors.csv',
    { preValidation: admins, schema: { params: idParam } },
    async (req, reply) => {
      const j = await load(getPrincipal(req), req.params.id);
      const results = ((j.result ?? []) as unknown as RowResult[]).filter((x) => x.status === 'error');
      const raw = (j.raw_rows ?? {}) as Record<string, Record<string, string>>;
      const csv = toCsv(
        ['row', 'code', 'field', 'message', ...COLUMNS],
        results.map((x) => [
          x.row,
          x.code,
          x.field,
          x.message,
          ...COLUMNS.map((c) => raw[String(x.row)]?.[c] ?? ''),
        ]),
      );
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="import-${j.id}-fehler.csv"`)
        .send(csv);
    },
  );

  r.get(
    '/imports/:id/credentials.pdf',
    { preValidation: admins, schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      await load(p, req.params.id);
      const pdf = await db.transaction().execute(async (trx) => {
        const j = await trx
          .selectFrom('import_job')
          .selectAll()
          .where('id', '=', req.params.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const now = app.clock();
        if (j.dry_run) throw notFound('Credentials');
        if (!j.credentials_enc || !j.credentials_expires_at || j.credentials_expires_at <= now)
          throw new AppError('CONFLICT', 'The credentials sheet was already downloaded or has expired');
        const slips = JSON.parse(app.keys.openText('import-credentials', j.credentials_enc)) as Slip[];
        const buf = await credentialsPdf(slips, `Zugangsdaten Import ${j.id}`);
        await trx
          .updateTable('import_job')
          .set({ credentials_enc: null, credentials_downloaded_at: now })
          .where('id', '=', j.id)
          .execute();
        await audit(trx, actorOf(req), {
          action: 'import_credentials_downloaded',
          entityType: 'import_job',
          entityId: j.id,
          new: { slips: slips.length },
        });
        return buf;
      });
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="zugangsdaten-import-${req.params.id}.pdf"`)
        .send(pdf);
    },
  );
}
