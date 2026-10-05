import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { AppError } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { idParam, pageQuery, paged } from '../lib/http';
import { employeeView } from './employees';
import { ACCESS_ACTIONS, anonymiseEmployee, collectEmployeeData } from '../services/privacy';
import type { Db } from '../db';

const admins = requireRole('superAdmin', 'admin');
const EM = requireRole('employee');

/** Data subject rights (GDPR Art. 15, 17, 20) and the log of who looked at personal data. */
export async function privacyRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  const sendExport = async (reply: import('fastify').FastifyReply, employeeId: number, fileTag: string) => {
    const data = await collectEmployeeData(db, employeeId);
    const body = JSON.stringify({ exportedAt: app.clock().toISOString(), ...data }, null, 2);
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="personal-data-${fileTag}.json"`)
      .header('cache-control', 'no-store')
      .send(body);
  };

  r.get(
    '/employees/:id/data-export',
    { preValidation: admins, schema: { params: idParam } },
    async (req, reply) => {
      const { e } = await employeeView(db, getPrincipal(req), req.params.id);
      if (e.anonymised_at) throw new AppError('CONFLICT', 'The data of this person was anonymised');
      await audit(db, actorOf(req), {
        action: 'personal_data_exported',
        entityType: 'employee',
        entityId: e.employee_id,
        companyId: e.company_id,
        hotelId: e.primary_hotel_id,
      });
      return sendExport(reply, e.employee_id, e.personnel_number);
    },
  );

  r.get('/me/data-export', { preValidation: EM }, async (req, reply) => {
    const p = getPrincipal(req);
    const { e } = await employeeView(db, p, p.employeeId!);
    await audit(db, actorOf(req), {
      action: 'personal_data_exported',
      entityType: 'employee',
      entityId: e.employee_id,
      companyId: e.company_id,
      hotelId: e.primary_hotel_id,
      reason: 'self',
    });
    return sendExport(reply, e.employee_id, e.personnel_number);
  });

  r.post(
    '/employees/:id/anonymise',
    {
      preValidation: admins,
      schema: { params: idParam, body: z.object({ reason: z.string().min(3).max(500) }) },
    },
    async (req) => {
      const p = getPrincipal(req);
      const { e } = await employeeView(db, p, req.params.id);
      const res = await db
        .transaction()
        .execute((trx) => anonymiseEmployee(trx, e.employee_id, app.clock(), actorOf(req), req.body.reason));
      return { ok: true, ...res };
    },
  );

  /** Entries about one person: views, exports, document downloads, anonymisation. */
  const accessRows = (d: Db, employeeId: number) =>
    d
      .selectFrom('audit_log as a')
      .leftJoin('user_account as u', 'u.id', 'a.actor_id')
      .select(['a.id', 'a.created_at', 'a.action', 'a.actor_type', 'a.actor_id', 'u.email', 'u.username'])
      .where('a.action', 'in', [...ACCESS_ACTIONS])
      .where((eb) =>
        eb.or([
          eb.and([eb('a.entity_type', '=', 'employee'), eb('a.entity_id', '=', employeeId)]),
          eb.and([
            eb('a.entity_type', '=', 'employee_document'),
            eb(
              'a.entity_id',
              'in',
              d.selectFrom('employee_document').select('id').where('employee_id', '=', employeeId),
            ),
          ]),
        ]),
      );

  r.get(
    '/employees/:id/access-log',
    { preValidation: admins, schema: { params: idParam, querystring: pageQuery } },
    async (req) => {
      const { e } = await employeeView(db, getPrincipal(req), req.params.id);
      const { page, pageSize } = req.query;
      const total = Number(
        (
          await accessRows(db, e.employee_id)
            .clearSelect()
            .select(sql<string>`count(*)`.as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      );
      const rows = await accessRows(db, e.employee_id)
        .orderBy('a.id', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .execute();
      return paged(
        rows.map((x) => ({
          id: Number(x.id),
          at: x.created_at?.toISOString() ?? null,
          action: x.action,
          actorType: x.actor_type,
          actor: x.email ?? x.username ?? null,
        })),
        page,
        pageSize,
        total,
      );
    },
  );

  // transparency for the person: when and by which kind of role their data was looked at (no names)
  r.get('/me/access-log', { preValidation: EM, schema: { querystring: pageQuery } }, async (req) => {
    const p = getPrincipal(req);
    const { page, pageSize } = req.query;
    const total = Number(
      (
        await accessRows(db, p.employeeId!)
          .clearSelect()
          .select(sql<string>`count(*)`.as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );
    const rows = await accessRows(db, p.employeeId!)
      .where('a.actor_id', '<>', p.userId)
      .orderBy('a.id', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    return paged(
      rows.map((x) => ({
        at: x.created_at?.toISOString() ?? null,
        action: x.action,
        actorType: x.actor_type,
      })),
      page,
      pageSize,
      total,
    );
  });
}
