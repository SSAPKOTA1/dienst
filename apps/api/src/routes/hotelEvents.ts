import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HOTEL_EVENT_KINDS } from '@dienst/shared';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { csvIds, idParam, isoDate } from '../lib/http';
import { eventOut, eventsInRange } from '../services/hotelEvents';
import type { Trx } from '../db';

const planners = requireRole('superAdmin', 'admin', 'manager');

const fields = z.object({
  title: z.string().trim().min(1).max(120),
  kind: z.enum(HOTEL_EVENT_KINDS),
  startDate: isoDate,
  endDate: isoDate,
  note: z.string().trim().max(2000).nullish(),
});
const checkDates = (b: { startDate: string; endDate: string }) => {
  if (b.endDate < b.startDate) throw new AppError('VALIDATION', 'The end date lies before the start date');
  if (Date.parse(b.endDate) - Date.parse(b.startDate) > 366 * 86_400_000)
    throw new AppError('VALIDATION', 'An entry may span at most one year');
};

/** Event calendar of a hotel: planners note Messe, Tagung, Gruppe ... so the plan can be staffed for them. */
export async function hotelEventRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);

  r.get(
    '/hotel-events',
    {
      preValidation: planners,
      schema: { querystring: z.object({ hotelIds: csvIds, from: isoDate, to: isoDate }) },
    },
    async (req) => {
      const hotels = getPrincipal(req).scope.hotels(req.query.hotelIds);
      return { items: await eventsInRange(db, hotels, req.query.from, req.query.to) };
    },
  );

  r.post(
    '/hotel-events',
    {
      preValidation: planners,
      schema: { body: fields.extend({ hotelId: z.number().int().positive() }) },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const b = req.body;
      p.scope.assertHotel(b.hotelId);
      checkDates(b);
      const row = await tx(async (trx) => {
        const e = await trx
          .insertInto('hotel_event')
          .values({
            hotel_id: b.hotelId,
            title: b.title,
            kind: b.kind,
            start_date: b.startDate,
            end_date: b.endDate,
            note: b.note || null,
            created_by_user_id: p.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'hotel_event_created',
          entityType: 'hotel_event',
          entityId: e.id,
          hotelId: e.hotel_id,
          new: eventOut(e),
        });
        return e;
      });
      return reply.status(201).send(eventOut(row));
    },
  );

  r.put(
    '/hotel-events/:id',
    { preValidation: planners, schema: { params: idParam, body: fields } },
    async (req) => {
      const p = getPrincipal(req);
      const b = req.body;
      checkDates(b);
      return tx(async (trx) => {
        const old = await trx
          .selectFrom('hotel_event')
          .selectAll()
          .where('id', '=', req.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!old) throw notFound('Event');
        p.scope.assertHotel(old.hotel_id);
        const e = await trx
          .updateTable('hotel_event')
          .set({
            title: b.title,
            kind: b.kind,
            start_date: b.startDate,
            end_date: b.endDate,
            note: b.note || null,
            updated_at: app.clock(),
          })
          .where('id', '=', old.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'hotel_event_updated',
          entityType: 'hotel_event',
          entityId: e.id,
          hotelId: e.hotel_id,
          old: eventOut(old),
          new: eventOut(e),
        });
        return eventOut(e);
      });
    },
  );

  r.delete(
    '/hotel-events/:id',
    { preValidation: planners, schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      await tx(async (trx) => {
        const old = await trx
          .selectFrom('hotel_event')
          .selectAll()
          .where('id', '=', req.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!old) throw notFound('Event');
        p.scope.assertHotel(old.hotel_id);
        await trx.deleteFrom('hotel_event').where('id', '=', old.id).execute();
        await audit(trx, actorOf(req), {
          action: 'hotel_event_deleted',
          entityType: 'hotel_event',
          entityId: old.id,
          hotelId: old.hotel_id,
          old: eventOut(old),
        });
      });
      return reply.status(204).send();
    },
  );
}
