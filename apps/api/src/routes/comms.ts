import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { addDays } from '@dienst/rules';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { csvIds, idParam, isoDate } from '../lib/http';
import { randomToken, sha256 } from '../lib/security';
import { localDate } from '../lib/time';
import { featureEnabled, requireFeature } from '../services/features';
import { notifyEmp, notifyPlanners } from '../services/collab';
import { loadAvailableRoles } from '../services/accounts';
import { icsCalendar } from '../services/ics';
import type { Db, Trx } from '../db';
import type { Principal } from '../lib/scope';

const planners = requireRole('superAdmin', 'admin', 'manager');
const admins = requireRole('superAdmin', 'admin');
const EM = requireRole('employee');
const ANY = requireRole('ANY');

/** Colleagues see each other as "away" only for these types; sickness and other health-related absences are never shown. */
const TEAM_VISIBLE_TYPES = [
  'annual_leave',
  'special_leave',
  'training',
  'comp_time',
  'unpaid_leave',
  'rest_day',
];

export async function commsRoutes(app: FastifyInstance) {
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
  const shortName = (first: string, last: string) => `${first} ${last.charAt(0)}.`;

  // ------------------------------------------------------------------ announcements
  const annOn = requireFeature(db, 'announcements');
  const annOut = (a: any, extra: Record<string, unknown> = {}) => ({
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
  const qOut = (q: any, extra: Record<string, unknown> = {}) => ({
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

  // ------------------------------------------------------------------ feed
  const feedOn = requireFeature(db, 'feed');
  const authorName = async (p: Principal): Promise<string> => {
    if (p.employeeId) {
      const e = await db
        .selectFrom('employee')
        .select(['first_name', 'last_name'])
        .where('employee_id', '=', p.employeeId)
        .executeTakeFirstOrThrow();
      return shortName(e.first_name, e.last_name);
    }
    const full = (await loadAvailableRoles(db, p.userId)).name.trim().split(/\s+/);
    return shortName(full[0] ?? '', full.slice(1).join(' ') || ' ');
  };
  const assertFeedHotel = async (p: Principal, hotelId: number) => {
    if (!(await hotelsOf(p)).includes(hotelId))
      throw new AppError('FORBIDDEN_SCOPE', 'Hotel is outside your scope');
  };

  r.get(
    '/feed',
    {
      preValidation: ANY,
      preHandler: feedOn,
      schema: {
        querystring: z.object({
          hotelId: z.coerce.number().int().positive().optional(),
          before: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      const mine = await hotelsOf(p);
      if (req.query.hotelId) await assertFeedHotel(p, req.query.hotelId);
      const hotels = req.query.hotelId ? [req.query.hotelId] : mine;
      if (!hotels.length) return { items: [] };
      let qb = db
        .selectFrom('feed_post')
        .selectAll()
        .where('hotel_id', 'in', hotels)
        .where('deleted_at', 'is', null)
        .orderBy('id', 'desc')
        .limit(req.query.limit);
      if (req.query.before) qb = qb.where('id', '<', req.query.before);
      const posts = await qb.execute();
      const ids = posts.map((x) => x.id);
      const comments = ids.length
        ? await db
            .selectFrom('feed_comment')
            .selectAll()
            .where('post_id', 'in', ids)
            .where('deleted_at', 'is', null)
            .orderBy('id')
            .execute()
        : [];
      const likes = ids.length
        ? await db
            .selectFrom('feed_like')
            .select(['post_id', 'user_id'])
            .where('post_id', 'in', ids)
            .execute()
        : [];
      const mod = !p.employeeId;
      return {
        items: posts.map((x) => ({
          id: x.id,
          hotelId: x.hotel_id,
          author: x.author_name,
          body: x.body,
          createdAt: x.created_at?.toISOString() ?? null,
          mine: x.author_user_id === p.userId,
          canDelete: mod || x.author_user_id === p.userId,
          likes: likes.filter((l) => l.post_id === x.id).length,
          likedByMe: likes.some((l) => l.post_id === x.id && l.user_id === p.userId),
          comments: comments
            .filter((c) => c.post_id === x.id)
            .map((c) => ({
              id: c.id,
              author: c.author_name,
              body: c.body,
              createdAt: c.created_at?.toISOString() ?? null,
              canDelete: mod || c.author_user_id === p.userId,
            })),
        })),
      };
    },
  );

  r.post(
    '/feed/posts',
    {
      preValidation: ANY,
      preHandler: feedOn,
      schema: {
        body: z.object({ hotelId: z.number().int().positive(), body: z.string().trim().min(1).max(2000) }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      await assertFeedHotel(p, req.body.hotelId);
      const row = await tx(async (trx) => {
        const x = await trx
          .insertInto('feed_post')
          .values({
            hotel_id: req.body.hotelId,
            author_user_id: p.userId,
            author_name: await authorName(p),
            body: req.body.body,
          })
          .returning(['id', 'author_name', 'body', 'hotel_id', 'created_at'])
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'feed_post_created',
          entityType: 'feed_post',
          entityId: x.id,
          hotelId: x.hotel_id,
        });
        return x;
      });
      return reply.status(201).send({
        id: row.id,
        hotelId: row.hotel_id,
        author: row.author_name,
        body: row.body,
        createdAt: row.created_at?.toISOString() ?? null,
      });
    },
  );

  const loadPost = async (p: Principal, id: number) => {
    const x = await db
      .selectFrom('feed_post')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!x) throw notFound('Post');
    await assertFeedHotel(p, x.hotel_id);
    return x;
  };

  r.delete(
    '/feed/posts/:id',
    { preValidation: ANY, preHandler: feedOn, schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      const x = await loadPost(p, req.params.id);
      if (p.employeeId && x.author_user_id !== p.userId)
        throw new AppError('FORBIDDEN_SCOPE', 'Only the author or the planners can delete a post');
      await tx(async (trx) => {
        await trx.updateTable('feed_post').set({ deleted_at: app.clock() }).where('id', '=', x.id).execute();
        await audit(trx, actorOf(req), {
          action: p.userId === x.author_user_id ? 'feed_post_deleted' : 'feed_post_moderated',
          entityType: 'feed_post',
          entityId: x.id,
          hotelId: x.hotel_id,
        });
      });
      return reply.status(204).send();
    },
  );

  r.post(
    '/feed/posts/:id/comments',
    {
      preValidation: ANY,
      preHandler: feedOn,
      schema: { params: idParam, body: z.object({ body: z.string().trim().min(1).max(1000) }) },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const x = await loadPost(p, req.params.id);
      const c = await db
        .insertInto('feed_comment')
        .values({
          post_id: x.id,
          author_user_id: p.userId,
          author_name: await authorName(p),
          body: req.body.body,
        })
        .returning(['id', 'author_name', 'body', 'created_at'])
        .executeTakeFirstOrThrow();
      return reply.status(201).send({
        id: c.id,
        author: c.author_name,
        body: c.body,
        createdAt: c.created_at?.toISOString() ?? null,
      });
    },
  );

  r.delete(
    '/feed/comments/:id',
    { preValidation: ANY, preHandler: feedOn, schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      const c = await db
        .selectFrom('feed_comment')
        .selectAll()
        .where('id', '=', req.params.id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!c) throw notFound('Comment');
      const post = await loadPost(p, c.post_id);
      if (p.employeeId && c.author_user_id !== p.userId)
        throw new AppError('FORBIDDEN_SCOPE', 'Only the author or the planners can delete a comment');
      await db.updateTable('feed_comment').set({ deleted_at: app.clock() }).where('id', '=', c.id).execute();
      await audit(db, actorOf(req), {
        action: 'feed_comment_deleted',
        entityType: 'feed_comment',
        entityId: c.id,
        hotelId: post.hotel_id,
      });
      return reply.status(204).send();
    },
  );

  r.put(
    '/feed/posts/:id/like',
    { preValidation: ANY, preHandler: feedOn, schema: { params: idParam } },
    async (req) => {
      const p = getPrincipal(req);
      const x = await loadPost(p, req.params.id);
      const had = await db
        .deleteFrom('feed_like')
        .where('post_id', '=', x.id)
        .where('user_id', '=', p.userId)
        .returning('post_id')
        .executeTakeFirst();
      if (!had) await db.insertInto('feed_like').values({ post_id: x.id, user_id: p.userId }).execute();
      const n = await db
        .selectFrom('feed_like')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('post_id', '=', x.id)
        .executeTakeFirstOrThrow();
      return { id: x.id, liked: !had, likes: Number(n.n) };
    },
  );

  // ------------------------------------------------------------------ calendar subscription (.ics)
  const calOn = requireFeature(db, 'calendar_feed');
  r.post('/me/calendar-feed', { preValidation: EM, preHandler: calOn }, async (req, reply) => {
    const p = getPrincipal(req);
    const token = randomToken();
    await tx(async (trx) => {
      const me = await myEmployee(trx, p);
      await trx
        .updateTable('calendar_feed')
        .set({ revoked_at: app.clock() })
        .where('employee_id', '=', me.employee_id)
        .where('revoked_at', 'is', null)
        .execute();
      await trx
        .insertInto('calendar_feed')
        .values({ employee_id: me.employee_id, token_hash: sha256(token) })
        .execute();
      await audit(trx, actorOf(req), {
        action: 'calendar_feed_created',
        entityType: 'employee',
        entityId: me.employee_id,
        hotelId: me.primary_hotel_id,
        companyId: me.company_id,
      });
    });
    // the token is shown once; only its hash is stored
    return reply.status(201).send({ token, path: `/api/v1/feeds/${token}.ics` });
  });

  r.delete('/me/calendar-feed', { preValidation: EM, preHandler: calOn }, async (req, reply) => {
    const me = await myEmployee(db, getPrincipal(req));
    await db
      .updateTable('calendar_feed')
      .set({ revoked_at: app.clock() })
      .where('employee_id', '=', me.employee_id)
      .where('revoked_at', 'is', null)
      .execute();
    return reply.status(204).send();
  });

  r.get(
    '/feeds/:file',
    { schema: { params: z.object({ file: z.string().regex(/^[A-Za-z0-9_-]{20,80}\.ics$/) }) } },
    async (req, reply) => {
      const token = req.params.file.slice(0, -4);
      const f = await db
        .selectFrom('calendar_feed')
        .selectAll()
        .where('token_hash', '=', sha256(token))
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!f) throw notFound('Calendar');
      const e = await db
        .selectFrom('employee')
        .selectAll()
        .where('employee_id', '=', f.employee_id)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!e || !(await featureEnabled(db, e.company_id, 'calendar_feed'))) throw notFound('Calendar');
      const now = app.clock();
      const today = localDate(now, 'Europe/Berlin');
      const shifts = await db
        .selectFrom('schedule as s')
        .innerJoin('hotel as h', 'h.id', 's.hotel_id')
        .leftJoin('shift as sh', 'sh.id', 's.shift_id')
        .select([
          's.id',
          's.planned_start',
          's.planned_end',
          'h.name as hotel',
          'sh.name as shift',
          's.version',
        ])
        .where('s.employee_id', '=', e.employee_id)
        .where('s.status', '=', 'published')
        .where('s.shift_date', '>=', addDays(today, -30))
        .where('s.shift_date', '<=', addDays(today, 180))
        .orderBy('s.planned_start')
        .execute();
      const absences = await db
        .selectFrom('time_off')
        .select(['id', 'start_date', 'end_date'])
        .where('employee_id', '=', e.employee_id)
        .where('status', '=', 'approved')
        .where('end_date', '>=', addDays(today, -30))
        .where('start_date', '<=', addDays(today, 180))
        .execute();
      const ics = icsCalendar({
        name: 'Dienstplan',
        events: [
          ...shifts.map((s) => ({
            uid: `shift-${s.id}@dienst`,
            summary: `Dienst${s.shift ? ` ${s.shift}` : ''}`,
            location: s.hotel,
            start: s.planned_start,
            end: s.planned_end,
            sequence: s.version,
          })),
          ...absences.map((a) => ({
            uid: `absence-${a.id}@dienst`,
            summary: 'Abwesend',
            allDay: { from: a.start_date, to: a.end_date },
          })),
        ],
      });
      return reply
        .header('content-type', 'text/calendar; charset=utf-8')
        .header('cache-control', 'private, max-age=300')
        .send(ics);
    },
  );

  // ------------------------------------------------------------------ team absences ("away" without reason)
  r.get(
    '/me/team-absences',
    { preValidation: EM, schema: { querystring: z.object({ from: isoDate, to: isoDate }) } },
    async (req) => {
      const me = await myEmployee(db, getPrincipal(req));
      const company = await db
        .selectFrom('company')
        .select('team_absence_visibility')
        .where('id', '=', me.company_id)
        .executeTakeFirstOrThrow();
      if (
        company.team_absence_visibility !== 'names_only' ||
        !(await featureEnabled(db, me.company_id, 'team_calendar'))
      )
        return { enabled: false, items: [] };
      const rows = await db
        .selectFrom('time_off as t')
        .innerJoin('employee as e', 'e.employee_id', 't.employee_id')
        .select(['e.display_name', 't.start_date', 't.end_date'])
        .where('e.primary_department_id', '=', me.primary_department_id)
        .where('e.employee_id', '<>', me.employee_id)
        .where('e.status', '=', 'active')
        .where('t.status', '=', 'approved')
        .where('t.type', 'in', TEAM_VISIBLE_TYPES)
        .where('t.end_date', '>=', req.query.from)
        .where('t.start_date', '<=', req.query.to)
        .orderBy('t.start_date')
        .execute();
      return {
        enabled: true,
        items: rows.map((x) => ({ displayName: x.display_name, from: x.start_date, to: x.end_date })),
      };
    },
  );

  r.put(
    '/settings/team-visibility',
    { preValidation: admins, schema: { body: z.object({ value: z.enum(['none', 'names_only']) }) } },
    async (req) => {
      const p = getPrincipal(req);
      const companyId = p.scope.companyIds[0];
      if (!companyId) throw new AppError('FORBIDDEN_SCOPE', 'No company in scope');
      return tx(async (trx) => {
        await trx
          .updateTable('company')
          .set({ team_absence_visibility: req.body.value })
          .where('id', '=', companyId)
          .execute();
        await audit(trx, actorOf(req), {
          action: 'team_visibility_changed',
          entityType: 'company',
          entityId: companyId,
          companyId,
          new: { value: req.body.value },
        });
        return { value: req.body.value };
      });
    },
  );
}
