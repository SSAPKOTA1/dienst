import type { QualificationDto, AvailabilityDto, DocumentDto, ExitStatementDto } from '@dienst/shared';
import type { DB } from '../db';
import type { Selectable } from 'kysely';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { csvIds, hhmm, idParam, isoDate } from '../lib/http';
import { localDate } from '../lib/time';
import { addDays } from '@dienst/rules';
import { requireFeature } from '../services/features';
import { assertPlannerEmployee } from '../services/planning/absence';
import { buildLedger } from '../services/timeAccount';
import { vacationSummary } from '../services/vacation';
import { deactivateEmployee } from '../services/offboarding';
import type { Db, Trx } from '../db';
import type { Principal } from '../lib/scope';

const planners = requireRole('superAdmin', 'admin', 'manager');
const admins = requireRole('superAdmin', 'admin');
const EM = requireRole('employee');
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const DOC_TYPES = [
  'contract',
  'hygiene_instruction',
  'work_permit',
  'training_certificate',
  'payslip',
  'other',
] as const;

const sniff = (b: Buffer): string | null =>
  b.subarray(0, 4).toString('latin1') === '%PDF'
    ? 'application/pdf'
    : b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      ? 'image/png'
      : b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
        ? 'image/jpeg'
        : null;

export async function peopleRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);
  const myEmployee = async (d: Db | Trx, p: Principal) => {
    if (!p.employeeId) throw new AppError('FORBIDDEN_SCOPE', 'No employee role selected');
    return d
      .selectFrom('employee')
      .selectAll()
      .where('employee_id', '=', p.employeeId)
      .executeTakeFirstOrThrow();
  };
  const companyOf = (p: Principal) => {
    const id = p.scope.companyIds[0];
    if (!id) throw new AppError('FORBIDDEN_SCOPE', 'No company in scope');
    return id;
  };
  const today = async (hotelId: number) =>
    localDate(
      app.clock(),
      (await db.selectFrom('hotel').select('timezone').where('id', '=', hotelId).executeTakeFirstOrThrow())
        .timezone,
    );

  // ------------------------------------------------------------------ qualifications
  const qualOut = (q: Selectable<DB['qualification']>): QualificationDto => ({
    id: q.id,
    name: q.name,
    hasExpiry: q.has_expiry,
  });
  const qualBody = z.object({
    name: z.string().trim().min(1).max(100),
    hasExpiry: z.boolean().default(false),
  });

  r.get(
    '/qualifications',
    {
      preValidation: planners,
      schema: { querystring: z.object({ companyId: z.coerce.number().int().positive().optional() }) },
    },
    async (req) => {
      const p = getPrincipal(req);
      const companyId = req.query.companyId ?? companyOf(p);
      p.scope.assertCompany(companyId);
      const rows = await db
        .selectFrom('qualification')
        .selectAll()
        .where('company_id', '=', companyId)
        .orderBy('name')
        .execute();
      return { items: rows.map(qualOut) };
    },
  );

  r.post('/qualifications', { preValidation: admins, schema: { body: qualBody } }, async (req, reply) => {
    const p = getPrincipal(req);
    const companyId = companyOf(p);
    const row = await tx(async (trx) => {
      const dup = await trx
        .selectFrom('qualification')
        .select('id')
        .where('company_id', '=', companyId)
        .where('name', '=', req.body.name)
        .executeTakeFirst();
      if (dup) throw new AppError('CONFLICT', 'A qualification with this name exists');
      const q = await trx
        .insertInto('qualification')
        .values({ company_id: companyId, name: req.body.name, has_expiry: req.body.hasExpiry })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), {
        action: 'qualification_created',
        entityType: 'qualification',
        entityId: q.id,
        companyId,
        new: qualOut(q),
      });
      return q;
    });
    return reply.status(201).send(qualOut(row));
  });

  r.put(
    '/qualifications/:id',
    { preValidation: admins, schema: { params: idParam, body: qualBody } },
    async (req) => {
      const p = getPrincipal(req);
      return tx(async (trx) => {
        const q = await trx
          .selectFrom('qualification')
          .selectAll()
          .where('id', '=', req.params.id)
          .executeTakeFirst();
        if (!q) throw notFound('Qualification');
        p.scope.assertCompany(q.company_id);
        const x = await trx
          .updateTable('qualification')
          .set({ name: req.body.name, has_expiry: req.body.hasExpiry })
          .where('id', '=', q.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'qualification_updated',
          entityType: 'qualification',
          entityId: q.id,
          companyId: q.company_id,
          old: qualOut(q),
          new: qualOut(x),
        });
        return qualOut(x);
      });
    },
  );

  r.delete(
    '/qualifications/:id',
    { preValidation: admins, schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      await tx(async (trx) => {
        const q = await trx
          .selectFrom('qualification')
          .selectAll()
          .where('id', '=', req.params.id)
          .executeTakeFirst();
        if (!q) throw notFound('Qualification');
        p.scope.assertCompany(q.company_id);
        const used =
          (await trx
            .selectFrom('employee_qualification')
            .select('employee_id')
            .where('qualification_id', '=', q.id)
            .executeTakeFirst()) ||
          (await trx
            .selectFrom('shift')
            .select('id')
            .where('required_qualification_id', '=', q.id)
            .executeTakeFirst());
        if (used) throw new AppError('CONFLICT', 'The qualification is assigned or required by a shift');
        await trx.deleteFrom('qualification').where('id', '=', q.id).execute();
        await audit(trx, actorOf(req), {
          action: 'qualification_deleted',
          entityType: 'qualification',
          entityId: q.id,
          companyId: q.company_id,
          old: qualOut(q),
        });
      });
      return reply.status(204).send();
    },
  );

  const heldOf = async (employeeId: number, h: Db | Trx = db) =>
    (
      await h
        .selectFrom('employee_qualification as eq')
        .innerJoin('qualification as q', 'q.id', 'eq.qualification_id')
        .select(['q.id', 'q.name', 'q.has_expiry', 'eq.valid_until'])
        .where('eq.employee_id', '=', employeeId)
        .orderBy('q.name')
        .execute()
    ).map((x) => ({
      qualificationId: x.id,
      name: x.name,
      hasExpiry: x.has_expiry,
      validUntil: x.valid_until,
    }));

  r.get(
    '/employees/:id/qualifications',
    { preValidation: planners, schema: { params: idParam } },
    async (req) => {
      const e = await assertPlannerEmployee(db, getPrincipal(req), req.params.id);
      return { items: await heldOf(e.employee_id) };
    },
  );

  r.put(
    '/employees/:id/qualifications',
    {
      preValidation: planners,
      schema: {
        params: idParam,
        body: z.object({
          items: z
            .array(z.object({ qualificationId: z.number().int().positive(), validUntil: isoDate.nullish() }))
            .max(50),
        }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      const e = await assertPlannerEmployee(db, p, req.params.id);
      return tx(async (trx) => {
        const ids = [...new Set(req.body.items.map((i) => i.qualificationId))];
        const quals = ids.length
          ? await trx
              .selectFrom('qualification')
              .selectAll()
              .where('id', 'in', ids)
              .where('company_id', '=', e.company_id)
              .execute()
          : [];
        if (quals.length !== ids.length) throw new AppError('VALIDATION', 'Unknown qualification');
        for (const i of req.body.items) {
          const q = quals.find((x) => x.id === i.qualificationId)!;
          if (q.has_expiry && !i.validUntil)
            throw new AppError('VALIDATION', `${q.name} needs a valid-until date`);
        }
        const old = await heldOf(e.employee_id);
        await trx.deleteFrom('employee_qualification').where('employee_id', '=', e.employee_id).execute();
        if (req.body.items.length)
          await trx
            .insertInto('employee_qualification')
            .values(
              req.body.items.map((i) => ({
                employee_id: e.employee_id,
                qualification_id: i.qualificationId,
                valid_until: i.validUntil ?? null,
              })),
            )
            .execute();
        await audit(trx, actorOf(req), {
          action: 'employee_qualifications_set',
          entityType: 'employee',
          entityId: e.employee_id,
          hotelId: e.primary_hotel_id,
          companyId: e.company_id,
          old,
          new: req.body.items,
        });
        return { items: await heldOf(e.employee_id, trx) };
      });
    },
  );

  r.get('/me/qualifications', { preValidation: EM }, async (req) => {
    const me = await myEmployee(db, getPrincipal(req));
    return { items: await heldOf(me.employee_id) };
  });

  // ------------------------------------------------------------------ availability
  const availOut = (a: Selectable<DB['employee_availability']>): AvailabilityDto => ({
    id: a.id,
    weekday: a.weekday,
    from: String(a.from_time).slice(0, 5),
    to: String(a.to_time).slice(0, 5),
    kind: a.kind,
    validFrom: a.valid_from,
    validTo: a.valid_to,
    note: a.note,
  });
  const availOn = requireFeature(db, 'availability');

  r.get('/me/availability', { preValidation: EM, preHandler: availOn }, async (req) => {
    const me = await myEmployee(db, getPrincipal(req));
    const rows = await db
      .selectFrom('employee_availability')
      .selectAll()
      .where('employee_id', '=', me.employee_id)
      .orderBy('weekday')
      .orderBy('from_time')
      .execute();
    return { items: rows.map(availOut) };
  });

  r.post(
    '/me/availability',
    {
      preValidation: EM,
      preHandler: availOn,
      schema: {
        body: z.object({
          weekday: z.number().int().min(1).max(7),
          from: hhmm,
          to: hhmm,
          kind: z.enum(['unavailable', 'preferred']),
          validFrom: isoDate.optional(),
          validTo: isoDate.nullish(),
          note: z.string().max(200).optional(),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const b = req.body;
      if (b.to <= b.from) throw new AppError('VALIDATION', 'to must be after from');
      const row = await tx(async (trx) => {
        const me = await myEmployee(trx, p);
        const vf = b.validFrom ?? (await today(me.primary_hotel_id));
        if (b.validTo && b.validTo < vf)
          throw new AppError('VALIDATION', 'validTo must not be before validFrom');
        const a = await trx
          .insertInto('employee_availability')
          .values({
            employee_id: me.employee_id,
            weekday: b.weekday,
            from_time: b.from,
            to_time: b.to,
            kind: b.kind,
            valid_from: vf,
            valid_to: b.validTo ?? null,
            note: b.note ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'availability_created',
          entityType: 'employee_availability',
          entityId: a.id,
          hotelId: me.primary_hotel_id,
          companyId: me.company_id,
          new: availOut(a),
        });
        return a;
      });
      return reply.status(201).send(availOut(row));
    },
  );

  r.delete(
    '/me/availability/:id',
    { preValidation: EM, preHandler: availOn, schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      await tx(async (trx) => {
        const me = await myEmployee(trx, p);
        const a = await trx
          .deleteFrom('employee_availability')
          .where('id', '=', req.params.id)
          .where('employee_id', '=', me.employee_id)
          .returningAll()
          .executeTakeFirst();
        if (!a) throw notFound('Availability');
        await audit(trx, actorOf(req), {
          action: 'availability_deleted',
          entityType: 'employee_availability',
          entityId: a.id,
          hotelId: me.primary_hotel_id,
          companyId: me.company_id,
          old: availOut(a),
        });
      });
      return reply.status(204).send();
    },
  );

  r.get(
    '/availability',
    {
      preValidation: planners,
      schema: {
        querystring: z.object({
          hotelIds: csvIds,
          employeeId: z.coerce.number().int().positive().optional(),
        }),
      },
    },
    async (req) => {
      const hotels = getPrincipal(req).scope.hotels(req.query.hotelIds);
      if (!hotels.length) return { items: [] };
      let qb = db
        .selectFrom('employee_availability as a')
        .innerJoin('employee as e', 'e.employee_id', 'a.employee_id')
        .select([
          'a.id',
          'a.employee_id',
          'a.weekday',
          'a.from_time',
          'a.to_time',
          'a.kind',
          'a.valid_from',
          'a.valid_to',
          'a.note',
          'e.display_name',
        ])
        .where('e.primary_hotel_id', 'in', hotels)
        .orderBy('a.employee_id')
        .orderBy('a.weekday');
      if (req.query.employeeId) qb = qb.where('a.employee_id', '=', req.query.employeeId);
      return {
        items: (await qb.execute()).map((a) => ({
          ...availOut(a),
          employeeId: a.employee_id,
          displayName: a.display_name,
        })),
      };
    },
  );

  // ------------------------------------------------------------------ documents (no health data)
  const docOut = (
    d: Pick<
      Selectable<DB['employee_document']>,
      | 'id'
      | 'employee_id'
      | 'doc_type'
      | 'title'
      | 'file_name'
      | 'mime'
      | 'size_bytes'
      | 'valid_until'
      | 'visible_to_employee'
      | 'created_at'
    >,
  ): DocumentDto => ({
    id: d.id,
    employeeId: d.employee_id,
    docType: d.doc_type,
    title: d.title,
    fileName: d.file_name,
    mime: d.mime,
    sizeBytes: d.size_bytes,
    validUntil: d.valid_until,
    visibleToEmployee: d.visible_to_employee,
    createdAt: d.created_at?.toISOString() ?? null,
  });
  const docCols = [
    'id',
    'employee_id',
    'doc_type',
    'title',
    'file_name',
    'mime',
    'size_bytes',
    'valid_until',
    'visible_to_employee',
    'created_at',
  ] as const;
  const docsOn = requireFeature(db, 'documents');

  r.post(
    '/employees/:id/documents',
    { preValidation: admins, schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      const e = await assertPlannerEmployee(db, p, req.params.id);
      if (!req.isMultipart())
        throw new AppError('VALIDATION', 'Send the file as multipart/form-data (field "file")');
      const fields: Record<string, string> = {};
      let file: { buf: Buffer; name: string; truncated: boolean } | null = null;
      for await (const part of req.parts({ limits: { fileSize: MAX_DOC_BYTES, files: 1 } })) {
        if (part.type === 'file') {
          const buf = await part.toBuffer();
          if (part.fieldname === 'file')
            file = { buf, name: part.filename ?? 'document', truncated: part.file.truncated };
        } else fields[part.fieldname] = String(part.value);
      }
      if (!file) throw new AppError('VALIDATION', 'Field "file" is missing');
      if (file.truncated)
        throw new AppError('PAYLOAD_TOO_LARGE', 'The file is larger than 10 MB', { maxBytes: MAX_DOC_BYTES });
      const meta = z
        .object({
          title: z.string().trim().min(1).max(200),
          docType: z.enum(DOC_TYPES),
          validUntil: isoDate.optional().or(z.literal('').transform(() => undefined)),
          visibleToEmployee: z.enum(['true', 'false']).default('true'),
        })
        .parse(fields);
      const mime = sniff(file.buf);
      if (!mime) throw new AppError('VALIDATION', 'Only PDF, PNG and JPEG files are accepted');
      const row = await tx(async (trx) => {
        const d = await trx
          .insertInto('employee_document')
          .values({
            employee_id: e.employee_id,
            doc_type: meta.docType,
            title: meta.title,
            file_name: file!.name.replace(/[^\w.\- ()äöüÄÖÜß]/g, '_').slice(0, 200),
            mime,
            size_bytes: file!.buf.length,
            content_enc: app.keys.seal('documents', file!.buf),
            valid_until: meta.validUntil ?? null,
            visible_to_employee: meta.visibleToEmployee === 'true',
            uploaded_by_user_id: p.userId,
          })
          .returning([...docCols])
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'document_uploaded',
          entityType: 'employee_document',
          entityId: d.id,
          hotelId: e.primary_hotel_id,
          companyId: e.company_id,
          new: { docType: meta.docType, title: meta.title, sizeBytes: d.size_bytes },
        });
        return d;
      });
      return reply.status(201).send(docOut(row));
    },
  );

  r.get('/employees/:id/documents', { preValidation: admins, schema: { params: idParam } }, async (req) => {
    const e = await assertPlannerEmployee(db, getPrincipal(req), req.params.id);
    const rows = await db
      .selectFrom('employee_document')
      .select([...docCols])
      .where('employee_id', '=', e.employee_id)
      .orderBy('id', 'desc')
      .execute();
    return { items: rows.map(docOut) };
  });

  const download = async (
    req: FastifyRequest,
    reply: FastifyReply,
    d: Pick<
      Selectable<DB['employee_document']>,
      'id' | 'employee_id' | 'file_name' | 'mime' | 'visible_to_employee' | 'content_enc'
    >,
    hotelId: number,
    companyId: number,
  ) => {
    await audit(db, actorOf(req), {
      action: 'document_downloaded',
      entityType: 'employee_document',
      entityId: d.id,
      hotelId,
      companyId,
    });
    const buf = app.keys.open('documents', d.content_enc);
    return reply
      .header('content-type', d.mime)
      .header('content-disposition', `attachment; filename="${d.file_name}"`)
      .header('cache-control', 'no-store')
      .send(buf);
  };

  r.get(
    '/documents/:id/download',
    { preValidation: admins, schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      const d = await db
        .selectFrom('employee_document')
        .selectAll()
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!d) throw notFound('Document');
      const e = await assertPlannerEmployee(db, p, d.employee_id);
      return download(req, reply, d, e.primary_hotel_id, e.company_id);
    },
  );

  r.delete('/documents/:id', { preValidation: admins, schema: { params: idParam } }, async (req, reply) => {
    const p = getPrincipal(req);
    await tx(async (trx) => {
      const d = await trx
        .selectFrom('employee_document')
        .select([...docCols])
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!d) throw notFound('Document');
      const e = await assertPlannerEmployee(trx, p, d.employee_id);
      await trx.deleteFrom('employee_document').where('id', '=', d.id).execute();
      await audit(trx, actorOf(req), {
        action: 'document_deleted',
        entityType: 'employee_document',
        entityId: d.id,
        hotelId: e.primary_hotel_id,
        companyId: e.company_id,
        old: docOut(d),
      });
    });
    return reply.status(204).send();
  });

  r.get(
    '/documents/expiring',
    {
      preValidation: admins,
      schema: { querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(60) }) },
    },
    async (req) => {
      const p = getPrincipal(req);
      const t = localDate(app.clock(), 'Europe/Berlin');
      const rows = await db
        .selectFrom('employee_document as d')
        .innerJoin('employee as e', 'e.employee_id', 'd.employee_id')
        .select(['d.id', 'd.employee_id', 'd.doc_type', 'd.title', 'd.valid_until', 'e.display_name'])
        .where('e.company_id', 'in', p.scope.companyIds.length ? p.scope.companyIds : [-1])
        .where('d.valid_until', 'is not', null)
        .where('d.valid_until', '<=', addDays(t, req.query.days))
        .orderBy('d.valid_until')
        .execute();
      const quals = await db
        .selectFrom('employee_qualification as eq')
        .innerJoin('employee as e', 'e.employee_id', 'eq.employee_id')
        .innerJoin('qualification as q', 'q.id', 'eq.qualification_id')
        .select(['eq.employee_id', 'q.name', 'eq.valid_until', 'e.display_name'])
        .where('e.company_id', 'in', p.scope.companyIds.length ? p.scope.companyIds : [-1])
        .where('e.status', '=', 'active')
        .where('eq.valid_until', 'is not', null)
        .where('eq.valid_until', '<=', addDays(t, req.query.days))
        .orderBy('eq.valid_until')
        .execute();
      return {
        documents: rows.map((d) => ({
          id: d.id,
          employeeId: d.employee_id,
          displayName: d.display_name,
          docType: d.doc_type,
          title: d.title,
          validUntil: d.valid_until,
          expired: d.valid_until! < t,
        })),
        qualifications: quals.map((q) => ({
          employeeId: q.employee_id,
          displayName: q.display_name,
          name: q.name,
          validUntil: q.valid_until,
          expired: q.valid_until! < t,
        })),
      };
    },
  );

  r.get('/me/documents', { preValidation: EM, preHandler: docsOn }, async (req) => {
    const me = await myEmployee(db, getPrincipal(req));
    const rows = await db
      .selectFrom('employee_document')
      .select([...docCols])
      .where('employee_id', '=', me.employee_id)
      .where('visible_to_employee', '=', true)
      .orderBy('id', 'desc')
      .execute();
    return { items: rows.map(docOut) };
  });

  r.get(
    '/me/documents/:id/download',
    { preValidation: EM, preHandler: docsOn, schema: { params: idParam } },
    async (req, reply) => {
      const me = await myEmployee(db, getPrincipal(req));
      const d = await db
        .selectFrom('employee_document')
        .selectAll()
        .where('id', '=', req.params.id)
        .where('employee_id', '=', me.employee_id)
        .where('visible_to_employee', '=', true)
        .executeTakeFirst();
      if (!d) throw notFound('Document');
      return download(req, reply, d, me.primary_hotel_id, me.company_id);
    },
  );

  // ------------------------------------------------------------------ offboarding
  const exitStatement = async (employeeId: number, lastDay: string): Promise<ExitStatementDto> => {
    const e = await db
      .selectFrom('employee')
      .selectAll()
      .where('employee_id', '=', employeeId)
      .executeTakeFirstOrThrow();
    const year = Number(lastDay.slice(0, 4));
    const vac = await vacationSummary(db, employeeId, year);
    const ledger = await buildLedger(db, employeeId, addDays(lastDay, 1));
    const pendingRecords = await db
      .selectFrom('punch_record')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('employee_id', '=', employeeId)
      .where('approval_status', '=', 'pending')
      .executeTakeFirstOrThrow();
    const openRecords = await db
      .selectFrom('punch_record')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('employee_id', '=', employeeId)
      .where('actual_punch_out', 'is', null)
      .executeTakeFirstOrThrow();
    const pendingCorrections = await db
      .selectFrom('time_correction_request')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('employee_id', '=', employeeId)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();
    const pendingRequests = await db
      .selectFrom('time_off')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('employee_id', '=', employeeId)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();
    const future = await db
      .selectFrom('schedule')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('employee_id', '=', employeeId)
      .where('status', '<>', 'cancelled')
      .where('shift_date', '>', lastDay)
      .executeTakeFirstOrThrow();
    return {
      employeeId,
      name: `${e.first_name} ${e.last_name}`,
      personnelNumber: e.personnel_number,
      lastDay,
      reason: e.termination_reason,
      // BUrlG § 7 Abs. 4: days that cannot be taken before the end of the employment are paid out
      vacation: { year, remainingDays: vac.remaining, payoutDays: Math.max(0, vac.remaining) },
      timeAccountHours: ledger?.balanceHours ?? null,
      open: {
        pendingTimeRecords: Number(pendingRecords.n),
        openTimeRecords: Number(openRecords.n),
        pendingCorrections: Number(pendingCorrections.n),
        pendingAbsenceRequests: Number(pendingRequests.n),
        plannedShiftsAfterLastDay: Number(future.n),
      },
    };
  };

  r.post(
    '/employees/:id/terminate',
    {
      preValidation: admins,
      schema: {
        params: idParam,
        body: z.object({ lastDay: isoDate, reason: z.string().max(300).optional() }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      const e = await assertPlannerEmployee(db, p, req.params.id);
      const { lastDay } = req.body;
      if (e.status !== 'active') throw new AppError('CONFLICT', 'The employee is not active');
      if (lastDay < e.contract_start_date)
        throw new AppError('VALIDATION', 'The last day is before the contract start');
      await tx(async (trx) => {
        const now = app.clock();
        const later = await trx
          .selectFrom('employee_contract')
          .select('id')
          .where('employee_id', '=', e.employee_id)
          .where('valid_from', '>', lastDay)
          .executeTakeFirst();
        if (later) throw new AppError('CONFLICT', 'A contract version starts after the last day');
        await trx
          .updateTable('employee_contract')
          .set({ valid_to: lastDay })
          .where('employee_id', '=', e.employee_id)
          .where('valid_from', '<=', lastDay)
          .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', lastDay)]))
          .execute();
        await trx
          .updateTable('employee')
          .set({
            contract_end_date: lastDay,
            terminated_at: now,
            termination_reason: req.body.reason ?? null,
            updated_at: now,
          })
          .where('employee_id', '=', e.employee_id)
          .execute();
        // planning stops after the last day: drafts disappear, published entries are cancelled
        await trx
          .deleteFrom('schedule')
          .where('employee_id', '=', e.employee_id)
          .where('status', '=', 'draft')
          .where('shift_date', '>', lastDay)
          .execute();
        await trx
          .updateTable('schedule')
          .set((eb) => ({
            status: 'cancelled',
            cancel_reason: 'changed',
            version: eb('version', '+', 1),
            updated_at: now,
          }))
          .where('employee_id', '=', e.employee_id)
          .where('status', '=', 'published')
          .where('shift_date', '>', lastDay)
          .execute();
        await audit(trx, actorOf(req), {
          action: 'employee_terminated',
          entityType: 'employee',
          entityId: e.employee_id,
          hotelId: e.primary_hotel_id,
          companyId: e.company_id,
          new: { lastDay },
          reason: req.body.reason ?? null,
        });
        if (lastDay < (await today(e.primary_hotel_id)))
          await deactivateEmployee(trx, e.employee_id, now, actorOf(req));
      });
      return exitStatement(e.employee_id, lastDay);
    },
  );

  r.get(
    '/employees/:id/exit-statement',
    { preValidation: admins, schema: { params: idParam } },
    async (req) => {
      const e = await assertPlannerEmployee(db, getPrincipal(req), req.params.id);
      if (!e.contract_end_date) throw new AppError('CONFLICT', 'The employment has no end date');
      return exitStatement(e.employee_id, e.contract_end_date);
    },
  );
}
