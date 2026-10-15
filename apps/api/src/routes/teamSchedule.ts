import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { addDays } from '@dienst/rules';
import { AppError } from '../lib/errors';
import { getPrincipal, requireRole } from '../lib/auth';
import { isoDate } from '../lib/http';
import { featureEnabled } from '../services/features';
import { myEmployee, TEAM_VISIBLE_TYPES } from '../services/collab';

const EM = requireRole('employee');
const MAX_DAYS = 14;

/**
 * Read-only team plan: the published shifts of every hotel the employee is assigned to, with colleagues' names
 * and times only. No hours, breaks, notes, wishes, contact data or absence types leave this endpoint.
 */
export async function teamScheduleRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  r.get(
    '/me/team-schedule',
    {
      preValidation: EM,
      schema: {
        querystring: z.object({ from: isoDate, to: isoDate, hotelId: z.coerce.number().int().optional() }),
      },
    },
    async (req) => {
      const { from, to, hotelId } = req.query;
      if (to < from || to > addDays(from, MAX_DAYS - 1))
        throw new AppError('VALIDATION', `The range must be 1 to ${MAX_DAYS} days`);
      const me = await myEmployee(db, getPrincipal(req));
      const hotels = await db
        .selectFrom('employee_hotel as eh')
        .innerJoin('hotel as h', 'h.id', 'eh.hotel_id')
        .select(['h.id', 'h.name'])
        .where('eh.employee_id', '=', me.employee_id)
        .where('h.is_active', '=', true)
        .orderBy('h.name')
        .execute();
      // the hotel filter can only narrow down to a hotel the caller is assigned to
      const ids = hotels.map((h) => h.id).filter((id) => hotelId === undefined || id === hotelId);
      if (!ids.length) return { hotels, entries: [], absences: [], absencesEnabled: false };

      const entries = await db
        .selectFrom('schedule as s')
        .innerJoin('employee as e', 'e.employee_id', 's.employee_id')
        .leftJoin('shift as sh', 'sh.id', 's.shift_id')
        .select([
          's.id',
          's.hotel_id',
          's.employee_id',
          's.shift_date',
          's.planned_start',
          's.planned_end',
          'e.display_name',
          'sh.name as shift_name',
        ])
        .where('s.hotel_id', 'in', ids)
        .where('s.status', '=', 'published')
        .where('e.status', '=', 'active')
        .where('s.shift_date', '>=', from)
        .where('s.shift_date', '<=', to)
        .orderBy('s.planned_start')
        .orderBy('e.last_name')
        .execute();

      const company = await db
        .selectFrom('company')
        .select('team_absence_visibility')
        .where('id', '=', me.company_id)
        .executeTakeFirstOrThrow();
      const absencesEnabled =
        company.team_absence_visibility === 'names_only' &&
        (await featureEnabled(db, me.company_id, 'team_calendar'));
      const absences = absencesEnabled
        ? await db
            .selectFrom('time_off as t')
            .innerJoin('employee as e', 'e.employee_id', 't.employee_id')
            .select(['t.employee_id', 'e.display_name', 't.start_date', 't.end_date'])
            .where('e.status', '=', 'active')
            .where('e.employee_id', 'in', (q) =>
              q.selectFrom('employee_hotel').select('employee_id').where('hotel_id', 'in', ids),
            )
            .where('t.status', '=', 'approved')
            .where('t.type', 'in', TEAM_VISIBLE_TYPES)
            .where('t.end_date', '>=', from)
            .where('t.start_date', '<=', to)
            .orderBy('t.start_date')
            .execute()
        : [];

      return {
        hotels,
        absencesEnabled,
        entries: entries.map((e) => ({
          id: e.id,
          date: e.shift_date,
          start: e.planned_start.toISOString(),
          end: e.planned_end.toISOString(),
          hotelId: e.hotel_id,
          employeeId: e.employee_id,
          displayName: e.display_name,
          shiftName: e.shift_name,
          mine: e.employee_id === me.employee_id,
        })),
        absences: absences.map((a) => ({
          employeeId: a.employee_id,
          displayName: a.display_name,
          from: a.start_date,
          to: a.end_date,
          mine: a.employee_id === me.employee_id,
        })),
      };
    },
  );
}
