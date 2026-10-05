import type { Selectable } from 'kysely';
import type { DB } from '../db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { csvIds, idParam } from '../lib/http';
import { requireFeature } from '../services/features';
import { notifyEmp, notifyPlanners, myEmployee } from '../services/collab';
import type { Trx } from '../db';
import type { Principal } from '../lib/scope';

const planners = requireRole('superAdmin', 'admin', 'manager');
const EM = requireRole('employee');
const ANY = requireRole('ANY');

export async function commsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);
  const hotelsOf = async (p: Principal): Promise<number[]> => {
    if (p.employeeId)
      return (
        await db
          .selectFrom('employee_hotel')
          .select('hotel_id')
          .where('employee_id', '=', p.employeeId)
          .execute()
      ).map((h) => h.hotel_id);
    return p.scope.hotelIds;
  };
  const companyOfHotel = async (hotelId: number) =>
    (await db.selectFrom('hotel').select('company_id').where('id', '=', hotelId).executeTakeFirstOrThrow())
      .company_id;

  // ------------------------------------------------------------------ announcements
  const annOn = requireFeature(db, 'announcements');
  const annOut = (a: Selectable<DB['announcement']>, extra: Record<string, unknown> = {}) => ({
    id: a.id,
    hotelId: a.hotel_id,
    title: a.title,
    body: a.body,
    pinned: a.pinned,
    requiresAck: a.requires_ack,
    publishAt: a.publish_at.toISOString(),
    ...extra,
  });

  r.post(
    '/announcements',
    {
      preValidation: planners,
      schema: {
        body: z.object({
          title: z.string().trim().min(1).max(200),
          body: z.string().trim().min(1).max(5000),
          hotelId: z.number().int().positive().nullish(),
          pinned: z.boolean().default(false),
          requiresAck: z.boolean().default(false),
          publishAt: z.string().datetime({ offset: true }).optional(),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const b = req.body;
      if (b.hotelId) p.scope.assertHotel(b.hotelId);
      else if (p.role === 'manager')
        throw new AppError('FORBIDDEN_SCOPE', 'Managers announce for their hotels only');
      const companyId = b.hotelId ? await companyOfHotel(b.hotelId) : p.scope.companyIds[0];
      if (!companyId) throw new AppError('FORBIDDEN_SCOPE', 'No company in scope');
      const row = await tx(async (trx) => {
        const now = app.clock();
        const publishAt = b.publishAt ? new Date(b.publishAt) : now;
        const a = await trx
          .insertInto('announcement')
          .values({
            company_id: companyId,
            hotel_id: b.hotelId ?? null,
            title: b.title,
            body: b.body,
            pinned: b.pinned,
            requires_ack: b.requiresAck,
            publish_at: publishAt,
            created_by_user_id: p.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        if (publishAt <= now) {
          const emps = await trx
            .selectFrom('employee as e')
            .select(['e.employee_id', 'e.user_id'])
            .where('e.company_id', '=', companyId)
            .where('e.status', '=', 'active')
            .where((eb) =>
              b.hotelId
                ? eb(
                    'e.employee_id',
                    'in',
                    eb.selectFrom('employee_hotel').select('employee_id').where('hotel_id', '=', b.hotelId),
                  )
                : eb.val(true),
            )
            .execute();
          for (const e of emps)
            await trx
              .insertInto('notification')
              .values({
                user_id: e.user_id,
                employee_id: e.employee_id,
                kind: 'announcement',
                payload: JSON.stringify({ announcementId: a.id, title: a.title }),
              })
              .execute();
        }
        await audit(trx, actorOf(req), {
          action: 'announcement_created',
          entityType: 'announcement',
          entityId: a.id,
          hotelId: b.hotelId ?? null,
          companyId,
          new: { title: b.title, requiresAck: b.requiresAck },
        });
        return a;
      });
      return reply.status(201).send(annOut(row));
    },
  );

  r.get(
    '/announcements',
    { preValidation: planners, schema: { querystring: z.object({ hotelIds: csvIds }) } },
    async (req) => {
      const p = getPrincipal(req);
      const hotels = p.scope.hotels(req.query.hotelIds);
      const rows = await db
        .selectFrom('announcement')
        .selectAll()
        .where('company_id', 'in', p.scope.companyIds.length ? p.scope.companyIds : [-1])
        .where((eb) =>
          eb.or([eb('hotel_id', 'is', null), eb('hotel_id', 'in', hotels.length ? hotels : [-1])]),
        )
        .orderBy('pinned', 'desc')
        .orderBy('id', 'desc')
        .limit(100)
        .execute();
      const items = [];
      for (const a of rows) {
        const recipients = await db
          .selectFrom('employee as e')
          .select(['e.employee_id', 'e.display_name'])
          .where('e.company_id', '=', a.company_id)
          .where('e.status', '=', 'active')
          .where((eb) =>
            a.hotel_id
              ? eb(
                  'e.employee_id',
                  'in',
                  eb.selectFrom('employee_hotel').select('employee_id').where('hotel_id', '=', a.hotel_id),
                )
              : eb.val(true),
          )
          .execute();
        const acks = await db
          .selectFrom('announcement_ack')
          .select('employee_id')
          .where('announcement_id', '=', a.id)
          .execute();
        const ackSet = new Set(acks.map((x) => x.employee_id));
        items.push(
          annOut(a, {
            recipients: recipients.length,
            acknowledged: recipients.filter((x) => ackSet.has(x.employee_id)).length,
            missing: a.requires_ack
              ? recipients.filter((x) => !ackSet.has(x.employee_id)).map((x) => x.display_name)
              : [],
          }),
        );
      }
      return { items };
    },
  );

  r.delete(
    '/announcements/:id',
    { preValidation: planners, schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      await tx(async (trx) => {
        const a = await trx
          .selectFrom('announcement')
          .selectAll()
          .where('id', '=', req.params.id)
          .executeTakeFirst();
        if (!a) throw notFound('Announcement');
        p.scope.assertCompany(a.company_id);
        if (a.hotel_id) p.scope.assertHotel(a.hotel_id);
        else if (p.role === 'manager')
          throw new AppError(
            'FORBIDDEN_SCOPE',
            'Company-wide announcements are managed by the administration',
          );
        await trx.deleteFrom('announcement_ack').where('announcement_id', '=', a.id).execute();
        await trx.deleteFrom('announcement').where('id', '=', a.id).execute();
        await audit(trx, actorOf(req), {
          action: 'announcement_deleted',
          entityType: 'announcement',
          entityId: a.id,
          hotelId: a.hotel_id,
          companyId: a.company_id,
          old: { title: a.title },
        });
      });
      return reply.status(204).send();
    },
  );

  r.get('/me/announcements', { preValidation: EM, preHandler: annOn }, async (req) => {
    const me = await myEmployee(db, getPrincipal(req));
    const hotels = await hotelsOf(getPrincipal(req));
    const rows = await db
      .selectFrom('announcement')
      .selectAll()
      .where('company_id', '=', me.company_id)
      .where('publish_at', '<=', app.clock())
      .where((eb) => eb.or([eb('hotel_id', 'is', null), eb('hotel_id', 'in', hotels.length ? hotels : [-1])]))
      .orderBy('pinned', 'desc')
      .orderBy('publish_at', 'desc')
      .limit(50)
      .execute();
    const acks = rows.length
      ? await db
          .selectFrom('announcement_ack')
          .select(['announcement_id', 'acknowledged_at'])
          .where('employee_id', '=', me.employee_id)
          .where(
            'announcement_id',
            'in',
            rows.map((x) => x.id),
          )
          .execute()
      : [];
    return {
      items: rows.map((a) => annOut(a, { acknowledged: acks.some((k) => k.announcement_id === a.id) })),
    };
  });

  r.put(
    '/me/announcements/:id/ack',
    { preValidation: EM, preHandler: annOn, schema: { params: idParam } },
    async (req) => {
      const p = getPrincipal(req);
      const me = await myEmployee(db, p);
      const hotels = await hotelsOf(p);
      const a = await db
        .selectFrom('announcement')
        .selectAll()
        .where('id', '=', req.params.id)
        .where('company_id', '=', me.company_id)
        .where('publish_at', '<=', app.clock())
        .where((eb) =>
          eb.or([eb('hotel_id', 'is', null), eb('hotel_id', 'in', hotels.length ? hotels : [-1])]),
        )
        .executeTakeFirst();
      if (!a) throw notFound('Announcement');
      await db
        .insertInto('announcement_ack')
        .values({ announcement_id: a.id, employee_id: me.employee_id, acknowledged_at: app.clock() })
        .onConflict((oc) => oc.doNothing())
        .execute();
      return { id: a.id, acknowledged: true };
    },
  );

  // ------------------------------------------------------------------ questions to management
  const msgOn = requireFeature(db, 'messages');
  const qOut = (q: Selectable<DB['management_question']>, extra: Record<string, unknown> = {}) => ({
    id: q.id,
    subject: q.subject,
    body: q.body,
    status: q.status,
    answer: q.answer,
    answeredAt: q.answered_at?.toISOString() ?? null,
    createdAt: q.created_at?.toISOString() ?? null,
    ...extra,
  });

  r.post(
    '/me/questions',
    {
      preValidation: EM,
      preHandler: msgOn,
      schema: {
        body: z.object({
          subject: z.string().trim().min(1).max(200),
          body: z.string().trim().min(1).max(3000),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const row = await tx(async (trx) => {
        const me = await myEmployee(trx, p);
        const q = await trx
          .insertInto('management_question')
          .values({
            employee_id: me.employee_id,
            hotel_id: me.primary_hotel_id,
            subject: req.body.subject,
            body: req.body.body,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await notifyPlanners(trx, me.primary_hotel_id, 'question_asked', { questionId: q.id });
        await audit(trx, actorOf(req), {
          action: 'question_asked',
          entityType: 'management_question',
          entityId: q.id,
          hotelId: me.primary_hotel_id,
          companyId: me.company_id,
        });
        return q;
      });
      return reply.status(201).send(qOut(row));
    },
  );

  r.get('/me/questions', { preValidation: EM, preHandler: msgOn }, async (req) => {
    const me = await myEmployee(db, getPrincipal(req));
    const rows = await db
      .selectFrom('management_question')
      .selectAll()
      .where('employee_id', '=', me.employee_id)
      .orderBy('id', 'desc')
      .limit(100)
      .execute();
    return { items: rows.map((q) => qOut(q)) };
  });

  r.get(
    '/questions',
    {
      preValidation: planners,
      schema: {
        querystring: z.object({ hotelIds: csvIds, status: z.enum(['open', 'answered']).default('open') }),
      },
    },
    async (req) => {
      const hotels = getPrincipal(req).scope.hotels(req.query.hotelIds);
      if (!hotels.length) return { items: [] };
      const rows = await db
        .selectFrom('management_question as q')
        .innerJoin('employee as e', 'e.employee_id', 'q.employee_id')
        .selectAll('q')
        .select('e.display_name')
        .where('q.hotel_id', 'in', hotels)
        .where('q.status', '=', req.query.status)
        .orderBy('q.id', 'desc')
        .limit(200)
        .execute();
      return {
        items: rows.map((q) =>
          qOut(q, { employeeId: q.employee_id, displayName: q.display_name, hotelId: q.hotel_id }),
        ),
      };
    },
  );

  r.put(
    '/questions/:id/answer',
    {
      preValidation: planners,
      schema: { params: idParam, body: z.object({ answer: z.string().trim().min(1).max(3000) }) },
    },
    async (req) => {
      const p = getPrincipal(req);
      return tx(async (trx) => {
        const q = await trx
          .selectFrom('management_question')
          .selectAll()
          .where('id', '=', req.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!q) throw notFound('Question');
        p.scope.assertHotel(q.hotel_id);
        const emp = await trx
          .selectFrom('employee')
          .select(['employee_id', 'user_id', 'company_id'])
          .where('employee_id', '=', q.employee_id)
          .executeTakeFirstOrThrow();
        if (emp.user_id === p.userId)
          throw new AppError('SELF_APPROVAL', 'You cannot answer your own question');
        await trx
          .updateTable('management_question')
          .set({
            status: 'answered',
            answer: req.body.answer,
            answered_by_user_id: p.userId,
            answered_at: app.clock(),
          })
          .where('id', '=', q.id)
          .execute();
        await notifyEmp(trx, emp.employee_id, 'question_answered', { questionId: q.id });
        await audit(trx, actorOf(req), {
          action: 'question_answered',
          entityType: 'management_question',
          entityId: q.id,
          hotelId: q.hotel_id,
          companyId: emp.company_id,
        });
        return { id: q.id, status: 'answered' };
      });
    },
  );

  /** the hotels the caller may use the feed in (for the hotel picker) */
  r.get('/me/hotels', { preValidation: ANY }, async (req) => {
    const hotels = await hotelsOf(getPrincipal(req));
    if (!hotels.length) return { items: [] };
    const rows = await db
      .selectFrom('hotel')
      .select(['id', 'name'])
      .where('id', 'in', hotels)
      .orderBy('name')
      .execute();
    return { items: rows };
  });
}
