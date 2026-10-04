import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { csvIds } from '../lib/http';
import { localDate } from '../lib/time';
import { graceOf, paidFor, computeClose } from '../services/kiosk';

const planners = requireRole('superAdmin', 'admin', 'manager');

export async function liveRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  r.get(
    '/live',
    { preValidation: planners, schema: { querystring: z.object({ hotelIds: csvIds }) } },
    async (req) => {
      const p = getPrincipal(req);
      const hotelIds = p.scope.hotels(req.query.hotelIds);
      const now = app.clock();
      const groups = {
        clockedIn: [] as any[],
        expectedNotIn: [] as any[],
        noShow: [] as any[],
        needsReview: [] as any[],
      };
      if (!hotelIds.length) return { serverTime: now.toISOString(), groups };
      const hotels = await db
        .selectFrom('hotel')
        .select(['id', 'timezone', 'name'])
        .where('id', 'in', hotelIds)
        .execute();
      const tz = new Map(hotels.map((h) => [h.id, h.timezone]));
      const open = await db
        .selectFrom('punch_record as pr')
        .innerJoin('employee as e', 'e.employee_id', 'pr.employee_id')
        .innerJoin('department as d', 'd.id', 'e.primary_department_id')
        .select([
          'pr.id',
          'pr.hotel_id',
          'pr.employee_id',
          'pr.actual_punch_in',
          'pr.planned_end',
          'pr.is_unplanned',
          'pr.start_variation_minutes',
          'e.display_name',
          'd.name as dept',
        ])
        .where('pr.hotel_id', 'in', hotelIds)
        .where('pr.actual_punch_out', 'is', null)
        .execute();
      for (const o of open) {
        const base = {
          punchRecordId: o.id,
          hotelId: o.hotel_id,
          employeeId: o.employee_id,
          displayName: o.display_name,
          departmentName: o.dept,
          since: o.actual_punch_in.toISOString(),
          plannedEnd: o.planned_end?.toISOString() ?? null,
        };
        const pastEnd = o.planned_end && now.getTime() > o.planned_end.getTime() + 60 * 60e3;
        const longUnplanned = o.is_unplanned && now.getTime() - o.actual_punch_in.getTime() > 10 * 3600e3;
        if (pastEnd || longUnplanned) {
          groups.needsReview.push({
            ...base,
            reason: pastEnd ? 'past_planned_end' : 'unplanned_long',
            openMinutes: Math.floor((now.getTime() - o.actual_punch_in.getTime()) / 60000),
          });
        } else {
          const flags: string[] = [];
          if (o.is_unplanned) flags.push('unplanned');
          if (o.start_variation_minutes != null && Math.abs(o.start_variation_minutes) > 15)
            flags.push('variation');
          groups.clockedIn.push({ ...base, flags });
        }
      }
      // today's published entries per hotel (hotel-local date)
      for (const h of hotels) {
        const today = localDate(now, h.timezone);
        const entries = await db
          .selectFrom('schedule as s')
          .innerJoin('employee as e', 'e.employee_id', 's.employee_id')
          .leftJoin('shift as sh', 'sh.id', 's.shift_id')
          .leftJoin('department as d', 'd.id', 'sh.department_id')
          .leftJoin('department as pd', 'pd.id', 'e.primary_department_id')
          .select([
            's.id',
            's.employee_id',
            's.planned_start',
            's.planned_end',
            'e.display_name',
            'd.name as dept',
            'pd.name as pdept',
          ])
          .where('s.hotel_id', '=', h.id)
          .where('s.shift_date', '=', today)
          .where('s.status', '=', 'published')
          .execute();
        if (!entries.length) continue;
        const punched = await db
          .selectFrom('punch_record')
          .select('schedule_id')
          .where(
            'schedule_id',
            'in',
            entries.map((e) => e.id),
          )
          .where('approval_status', '<>', 'rejected')
          .execute();
        const has = new Set(punched.map((x) => x.schedule_id));
        for (const e of entries) {
          if (has.has(e.id)) continue;
          const lateMin = Math.floor((now.getTime() - e.planned_start.getTime()) / 60000);
          const item = {
            entryId: e.id,
            hotelId: h.id,
            employeeId: e.employee_id,
            displayName: e.display_name,
            departmentName: e.dept ?? e.pdept,
            plannedStart: e.planned_start.toISOString(),
            plannedEnd: e.planned_end.toISOString(),
            minutesLate: Math.max(0, lateMin),
          };
          if (lateMin >= 60) groups.noShow.push(item);
          else if (lateMin >= 10 && now < e.planned_end) groups.expectedNotIn.push(item);
        }
      }
      void tz;
      return { serverTime: now.toISOString(), groups };
    },
  );

  r.post(
    '/live/close-open',
    {
      preValidation: planners,
      schema: {
        body: z.object({
          punchRecordId: z.number().int().positive(),
          outAt: z.string().datetime({ offset: true }),
          breakMinutes: z.number().int().min(0).max(240),
          reason: z.string().min(5).max(300),
        }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      const b = req.body;
      const now = app.clock();
      return db.transaction().execute(async (trx) => {
        const rec = await trx
          .selectFrom('punch_record')
          .selectAll()
          .where('id', '=', b.punchRecordId)
          .forUpdate()
          .executeTakeFirst();
        if (!rec) throw notFound('Time record');
        p.scope.assertHotel(rec.hotel_id);
        const emp = await trx
          .selectFrom('employee')
          .select(['employee_id', 'user_id', 'company_id'])
          .where('employee_id', '=', rec.employee_id)
          .executeTakeFirstOrThrow();
        if (emp.user_id === p.userId)
          throw new AppError('SELF_APPROVAL', 'You cannot close your own time record');
        if (rec.actual_punch_out) throw new AppError('CONFLICT', 'The record is already closed');
        const outAt = new Date(b.outAt);
        if (outAt <= rec.actual_punch_in || outAt > now)
          throw new AppError('VALIDATION', 'outAt must be after the clock-in and not in the future');
        const closed = await trx
          .selectFrom('payroll_period')
          .select('id')
          .where('company_id', '=', emp.company_id)
          .where('status', '=', 'closed')
          .where('period_start', '<=', rec.shift_date)
          .where('period_end', '>=', rec.shift_date)
          .executeTakeFirst();
        if (closed) throw new AppError('PERIOD_CLOSED', 'The payroll period is closed');
        const grace = await graceOf(trx, emp.company_id);
        const c = computeClose(
          {
            paid_start: rec.paid_start,
            actual_punch_in: rec.actual_punch_in,
            planned_end: rec.planned_end,
            is_unplanned: true,
          },
          outAt,
          grace,
        ); // times as entered by the planner
        const hours = paidFor(c.paidStart, c.paidEnd, b.breakMinutes);
        const upd = await trx
          .updateTable('punch_record')
          .set({
            actual_punch_out: outAt,
            paid_end: outAt,
            paid_hours: hours,
            actual_break_minutes: b.breakMinutes,
            required_break_minutes: c.requiredBreak,
            under_break_warning: b.breakMinutes < c.requiredBreak,
            source: 'correction',
            approval_status: 'approved',
            approval_source: 'manual',
            approved_by_user_id: p.userId,
            approved_by_role: p.role === 'superAdmin' ? 'super_admin' : (p.role as 'admin' | 'manager'),
            approved_at: now,
            approval_notes: b.reason,
            created_by_user_id: p.userId,
            updated_at: now,
          })
          .where('id', '=', rec.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('time_variation')
          .set({
            status: 'approved',
            reviewed_by_user_id: p.userId,
            reviewed_by_role: p.role === 'superAdmin' ? 'super_admin' : (p.role as 'admin' | 'manager'),
            reviewed_at: now,
          })
          .where('punch_record_id', '=', rec.id)
          .where('status', '=', 'pending')
          .execute();
        await trx
          .insertInto('punch_record_history')
          .values({
            punch_record_id: rec.id,
            changed_by_user_id: p.userId,
            changed_by_role: p.role === 'superAdmin' ? 'super_admin' : p.role,
            change_type: 'close_open',
            old_values: JSON.stringify({ actual_punch_out: null }),
            new_values: JSON.stringify({
              actual_punch_out: outAt.toISOString(),
              actual_break_minutes: b.breakMinutes,
              paid_hours: hours,
            }),
            reason: b.reason,
          })
          .execute();
        await trx
          .insertInto('notification')
          .values({
            user_id: emp.user_id,
            employee_id: emp.employee_id,
            kind: 'approval_decision',
            payload: JSON.stringify({ punchRecordId: rec.id, decision: 'closed' }),
          })
          .execute();
        await audit(trx, actorOf(req), {
          action: 'close_open_record',
          entityType: 'punch_record',
          entityId: rec.id,
          hotelId: rec.hotel_id,
          companyId: emp.company_id,
          old: { open: true },
          new: { outAt: outAt.toISOString(), breakMinutes: b.breakMinutes, paidHours: hours },
          reason: b.reason,
        });
        return { punchRecordId: upd.id, paidHours: hours, approvalStatus: upd.approval_status };
      });
    },
  );
}
