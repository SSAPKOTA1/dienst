import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { addDays, buildSuggestion } from '@dienst/rules';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { idParam, isoDate } from '../lib/http';
import { loadStaffing, requiredOn } from '../services/staffing';
import type { Trx } from '../db';

const PLANNER = requireRole('superAdmin', 'admin', 'manager');
const range = z.object({ hotelId: z.coerce.number().int().positive(), from: isoDate, to: isoDate });

export async function occupancyRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);

  const checkRange = (from: string, to: string) => {
    if (to < from || addDays(from, 400) < to) throw new AppError('VALIDATION', 'Invalid date range');
  };

  // ---- forecast import
  r.put(
    '/occupancy',
    {
      preValidation: PLANNER,
      schema: {
        body: z.object({
          hotelId: z.number().int().positive(),
          items: z
            .array(z.object({ date: isoDate, occupancyPct: z.number().int().min(0).max(100) }))
            .min(1)
            .max(400),
        }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      p.scope.assertHotel(req.body.hotelId);
      const byDate = new Map(req.body.items.map((i) => [i.date, i.occupancyPct]));
      return tx(async (trx) => {
        const rows = [...byDate].map(([d, pct]) => ({
          hotel_id: req.body.hotelId,
          on_date: d,
          occupancy_pct: pct,
        }));
        await trx
          .insertInto('occupancy_forecast')
          .values(rows)
          .onConflict((oc) =>
            oc
              .columns(['hotel_id', 'on_date'])
              .doUpdateSet((eb) => ({ occupancy_pct: eb.ref('excluded.occupancy_pct') })),
          )
          .execute();
        await audit(trx, actorOf(req), {
          action: 'occupancy_imported',
          entityType: 'hotel',
          entityId: req.body.hotelId,
          hotelId: req.body.hotelId,
          new: { days: rows.length },
        });
        return { saved: rows.length };
      });
    },
  );

  r.get('/occupancy', { preValidation: PLANNER, schema: { querystring: range } }, async (req) => {
    getPrincipal(req).scope.assertHotel(req.query.hotelId);
    checkRange(req.query.from, req.query.to);
    const rows = await db
      .selectFrom('occupancy_forecast')
      .select(['on_date', 'occupancy_pct'])
      .where('hotel_id', '=', req.query.hotelId)
      .where('on_date', '>=', req.query.from)
      .where('on_date', '<=', req.query.to)
      .orderBy('on_date')
      .execute();
    return {
      items: rows.map((x) => ({ date: x.on_date as unknown as string, occupancyPct: x.occupancy_pct })),
    };
  });

  // ---- rules ("from X % this shift needs N people")
  const ruleOut = (x: any) => ({
    id: x.id,
    hotelId: x.hotel_id,
    shiftId: x.shift_id,
    shiftName: x.shift_name ?? undefined,
    minOccupancyPct: x.min_occupancy_pct,
    headcount: x.headcount,
  });
  r.get(
    '/staffing-rules',
    {
      preValidation: PLANNER,
      schema: { querystring: z.object({ hotelId: z.coerce.number().int().positive() }) },
    },
    async (req) => {
      getPrincipal(req).scope.assertHotel(req.query.hotelId);
      const rows = await db
        .selectFrom('staffing_rule as sr')
        .innerJoin('shift as s', 's.id', 'sr.shift_id')
        .selectAll('sr')
        .select('s.name as shift_name')
        .where('sr.hotel_id', '=', req.query.hotelId)
        .orderBy('s.name')
        .orderBy('sr.min_occupancy_pct')
        .execute();
      return { items: rows.map(ruleOut) };
    },
  );
  r.post(
    '/staffing-rules',
    {
      preValidation: PLANNER,
      schema: {
        body: z.object({
          hotelId: z.number().int().positive(),
          shiftId: z.number().int().positive(),
          minOccupancyPct: z.number().int().min(0).max(100),
          headcount: z.number().int().min(0).max(500),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const b = req.body;
      p.scope.assertHotel(b.hotelId);
      const row = await tx(async (trx) => {
        const sh = await trx
          .selectFrom('shift')
          .select(['id', 'hotel_id'])
          .where('id', '=', b.shiftId)
          .executeTakeFirst();
        if (!sh || sh.hotel_id !== b.hotelId)
          throw new AppError('VALIDATION', 'The shift does not belong to this hotel');
        const row = await trx
          .insertInto('staffing_rule')
          .values({
            hotel_id: b.hotelId,
            shift_id: b.shiftId,
            min_occupancy_pct: b.minOccupancyPct,
            headcount: b.headcount,
          })
          .onConflict((oc) =>
            oc.columns(['shift_id', 'min_occupancy_pct']).doUpdateSet({ headcount: b.headcount }),
          )
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'staffing_rule_saved',
          entityType: 'staffing_rule',
          entityId: row.id,
          hotelId: b.hotelId,
          new: ruleOut(row),
        });
        return row;
      });
      return reply.status(201).send(ruleOut(row));
    },
  );
  r.delete(
    '/staffing-rules/:id',
    { preValidation: PLANNER, schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      await tx(async (trx) => {
        const row = await trx
          .selectFrom('staffing_rule')
          .selectAll()
          .where('id', '=', req.params.id)
          .executeTakeFirst();
        if (!row) throw notFound('Rule');
        p.scope.assertHotel(row.hotel_id);
        await trx.deleteFrom('staffing_rule').where('id', '=', row.id).execute();
        await audit(trx, actorOf(req), {
          action: 'staffing_rule_deleted',
          entityType: 'staffing_rule',
          entityId: row.id,
          hotelId: row.hotel_id,
          old: ruleOut(row),
        });
      });
      return reply.status(204).send();
    },
  );

  // ---- suggestions (read-only) and applying them as date overrides of the requirement
  r.get('/staffing/suggestions', { preValidation: PLANNER, schema: { querystring: range } }, async (req) => {
    const { hotelId, from, to } = req.query;
    getPrincipal(req).scope.assertHotel(hotelId);
    checkRange(from, to);
    const [forecast, rules] = await Promise.all([
      db
        .selectFrom('occupancy_forecast')
        .select(['on_date', 'occupancy_pct'])
        .where('hotel_id', '=', hotelId)
        .where('on_date', '>=', from)
        .where('on_date', '<=', to)
        .execute(),
      db
        .selectFrom('staffing_rule as sr')
        .innerJoin('shift as s', 's.id', 'sr.shift_id')
        .select(['sr.shift_id', 'sr.min_occupancy_pct', 'sr.headcount', 's.name'])
        .where('sr.hotel_id', '=', hotelId)
        .execute(),
    ]);
    const shiftIds = [...new Set(rules.map((x) => x.shift_id))];
    const staffing = await loadStaffing(db, shiftIds);
    const planned = shiftIds.length
      ? await db
          .selectFrom('schedule')
          .select(['shift_id', 'shift_date'])
          .where('hotel_id', '=', hotelId)
          .where('shift_id', 'in', shiftIds)
          .where('shift_date', '>=', from)
          .where('shift_date', '<=', to)
          .where('status', '<>', 'cancelled')
          .execute()
      : [];
    const count = new Map<string, number>();
    for (const x of planned) {
      const key = `${x.shift_id}|${x.shift_date as unknown as string}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
    const names = new Map(rules.map((x) => [x.shift_id, x.name]));
    const items = [];
    for (const f of forecast) {
      const date = f.on_date as unknown as string;
      for (const sid of shiftIds) {
        const s = buildSuggestion({
          date,
          shiftId: sid,
          occupancyPct: f.occupancy_pct,
          rules: rules
            .filter((x) => x.shift_id === sid)
            .map((x) => ({ minOccupancyPct: x.min_occupancy_pct, headcount: x.headcount })),
          required: requiredOn(staffing.get(sid), date),
          planned: count.get(`${sid}|${date}`) ?? 0,
        });
        if (s) items.push({ ...s, shiftName: names.get(sid) });
      }
    }
    items.sort((a, b) => a.date.localeCompare(b.date) || a.shiftId - b.shiftId);
    return { items };
  });

  r.post(
    '/staffing/apply',
    {
      preValidation: PLANNER,
      schema: {
        body: z.object({
          hotelId: z.number().int().positive(),
          items: z
            .array(
              z.object({
                shiftId: z.number().int().positive(),
                date: isoDate,
                headcount: z.number().int().min(0).max(500),
              }),
            )
            .min(1)
            .max(800),
        }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      const b = req.body;
      p.scope.assertHotel(b.hotelId);
      return tx(async (trx) => {
        const shifts = await trx
          .selectFrom('shift')
          .select(['id', 'hotel_id'])
          .where('id', 'in', [...new Set(b.items.map((i) => i.shiftId))])
          .execute();
        const ok = new Set(shifts.filter((s) => s.hotel_id === b.hotelId).map((s) => s.id));
        for (const i of b.items)
          if (!ok.has(i.shiftId))
            throw new AppError('VALIDATION', 'A shift does not belong to this hotel', { shiftId: i.shiftId });
        const old = await loadStaffing(trx, [...ok]);
        for (const i of b.items) {
          await trx
            .insertInto('shift_staffing_requirement')
            .values({ shift_id: i.shiftId, weekday: null, on_date: i.date, required_headcount: i.headcount })
            .onConflict((oc) =>
              oc
                .columns(['shift_id', 'on_date'])
                .where('on_date', 'is not', null)
                .doUpdateSet({ required_headcount: i.headcount }),
            )
            .execute();
        }
        await audit(trx, actorOf(req), {
          action: 'staffing_suggestions_applied',
          entityType: 'hotel',
          entityId: b.hotelId,
          hotelId: b.hotelId,
          old: b.items.map((i) => ({
            shiftId: i.shiftId,
            date: i.date,
            headcount: old.get(i.shiftId)?.overrides.get(i.date) ?? null,
          })),
          new: b.items,
        });
        return { applied: b.items.length };
      });
    },
  );
}
