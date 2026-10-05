import type { PayrollPeriodDto } from '@dienst/shared';
import type { DB } from '../db';
import type { Selectable } from 'kysely';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit, verifyAuditChains } from '../lib/audit';
import { csvIds, idParam, isoDate } from '../lib/http';
import { toCsv } from '../lib/csv';
import { localDate } from '../lib/time';
import { vacationSummary } from '../services/vacation';
import { leaveLimitIssues } from '../services/leave';
import {
  decideAbsence,
  decideCorrection,
  decideWorkedTime,
  flagsOf,
  listWorkedTime,
  understaffingHint,
  vacationDays,
} from '../services/approvals';
import type { Trx } from '../db';

const planners = requireRole('superAdmin', 'admin', 'manager');
const adminsOnly = requireRole('superAdmin', 'admin');

const FLAGS = ['variation', 'unplanned', 'auto_checkout', 'under_break', 'correction'] as const;

export async function approvalRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);

  const todayFor = async (hotelIds: number[]) => {
    const h = hotelIds.length
      ? await db
          .selectFrom('hotel')
          .select('timezone')
          .where('id', 'in', hotelIds)
          .limit(1)
          .executeTakeFirst()
      : undefined;
    return localDate(app.clock(), h?.timezone ?? 'Europe/Berlin');
  };

  // ------------------------------------------------------------------ inbox
  r.get(
    '/approvals',
    {
      preValidation: planners,
      schema: {
        querystring: z.object({
          hotelId: z.coerce.number().int().positive().optional(),
          type: z.enum(['worked_time', 'correction', 'absence']).default('worked_time'),
          status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
          from: isoDate.optional(),
          to: isoDate.optional(),
          flag: z.enum(FLAGS).optional(),
        }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      const q = req.query;
      const hotelIds = p.scope.hotels(q.hotelId ? [q.hotelId] : undefined);
      const today = await todayFor(hotelIds);
      if (q.type === 'worked_time') {
        const items = await listWorkedTime(db, hotelIds, q, today, q.flag);
        return { items, total: items.length };
      }
      if (!hotelIds.length) return { items: [], total: 0 };
      if (q.type === 'correction') {
        let qb = db
          .selectFrom('time_correction_request as c')
          .innerJoin('employee as e', 'e.employee_id', 'c.employee_id')
          .selectAll('c')
          .select('e.display_name')
          .where('c.hotel_id', 'in', hotelIds)
          .where('c.status', '=', q.status)
          .orderBy('c.id', 'desc')
          .limit(500);
        if (q.from) qb = qb.where('c.created_at', '>=', new Date(`${q.from}T00:00:00Z`));
        if (q.to) qb = qb.where('c.created_at', '<', new Date(`${q.to}T23:59:59Z`));
        const rows = await qb.execute();
        const items = rows.map((c) => ({
          id: c.id,
          type: 'correction' as const,
          hotelId: c.hotel_id,
          employeeId: c.employee_id,
          displayName: c.display_name ?? '',
          correctionType: c.correction_type,
          punchRecordId: c.punch_record_id,
          requestedIn: c.requested_in?.toISOString() ?? null,
          requestedOut: c.requested_out?.toISOString() ?? null,
          requestedBreakMinutes: c.requested_break_minutes,
          reason: c.reason,
          status: c.status,
          decisionNotes: c.decision_notes,
          createdAt: c.created_at?.toISOString() ?? null,
          flags: ['correction'],
        }));
        return { items, total: items.length };
      }
      // absence requests of employees working at one of the caller's hotels
      let qb = db
        .selectFrom('time_off as t')
        .innerJoin('employee as e', 'e.employee_id', 't.employee_id')
        .select([
          't.id',
          't.employee_id',
          't.start_date',
          't.end_date',
          't.type',
          't.reason',
          't.status',
          't.time_off_days',
          't.half_day',
          't.decision_note',
          't.created_by_user_id',
          'e.user_id as emp_user_id',
          'e.display_name',
          'e.primary_hotel_id',
          't.created_at',
        ])
        .where('t.status', '=', q.status)
        .where('t.type', '=', 'annual_leave')
        .where((eb) =>
          eb.or([
            eb('e.primary_hotel_id', 'in', hotelIds),
            eb(
              'e.employee_id',
              'in',
              eb.selectFrom('employee_hotel').select('employee_id').where('hotel_id', 'in', hotelIds),
            ),
          ]),
        )
        .orderBy('t.start_date')
        .limit(500);
      // pending requests are those the employee made themselves
      if (q.status === 'pending') qb = qb.whereRef('t.created_by_user_id', '=', 'e.user_id');
      if (q.from) qb = qb.where('t.end_date', '>=', q.from);
      if (q.to) qb = qb.where('t.start_date', '<=', q.to);
      const rows = await qb.execute();
      const items = [];
      for (const t of rows) {
        const days = await vacationDays(db, t.employee_id, t.start_date, t.end_date);
        const year = Number(t.start_date.slice(0, 4));
        const v = await vacationSummary(db, t.employee_id, year);
        // for a pending request nothing is booked yet; an approved one is already included in `used`
        const n = t.half_day ? 0.5 : days.length;
        const remaining = t.status === 'approved' ? v.remaining + n : v.remaining;
        items.push({
          id: t.id,
          type: 'absence' as const,
          hotelId: t.primary_hotel_id,
          employeeId: t.employee_id,
          displayName: t.display_name ?? '',
          from: t.start_date,
          to: t.end_date,
          days: n,
          halfDay: t.half_day,
          reason: t.reason,
          status: t.status,
          decisionNote: t.decision_note,
          remaining,
          remainingAfter: remaining - n,
          conflicts:
            t.status === 'pending'
              ? await leaveLimitIssues(db, t.employee_id, t.start_date, t.end_date, days)
              : [],
          understaffing: t.status === 'pending' ? await understaffingHint(db, t.employee_id, days) : [],
          createdAt: t.created_at?.toISOString() ?? null,
          flags: [] as string[],
        });
      }
      return { items, total: items.length };
    },
  );

  r.get('/approvals/count', { preValidation: planners }, async (req) => {
    const p = getPrincipal(req);
    const hotelIds = p.scope.hotelIds;
    if (!hotelIds.length) return { total: 0, workedTime: 0, corrections: 0, absences: 0, questions: 0 };
    const w = await db
      .selectFrom('punch_record')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('hotel_id', 'in', hotelIds)
      .where('approval_status', '=', 'pending')
      .where('actual_punch_out', 'is not', null)
      .executeTakeFirstOrThrow();
    const c = await db
      .selectFrom('time_correction_request')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('hotel_id', 'in', hotelIds)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();
    const a = await db
      .selectFrom('time_off as t')
      .innerJoin('employee as e', 'e.employee_id', 't.employee_id')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('t.status', '=', 'pending')
      .where('t.type', '=', 'annual_leave')
      .whereRef('t.created_by_user_id', '=', 'e.user_id')
      .where('e.primary_hotel_id', 'in', hotelIds)
      .executeTakeFirstOrThrow();
    const qs = await db
      .selectFrom('management_question')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('hotel_id', 'in', hotelIds)
      .where('status', '=', 'open')
      .executeTakeFirstOrThrow();
    const questions = Number(qs.n);
    const workedTime = Number(w.n);
    const corrections = Number(c.n);
    const absences = Number(a.n);
    return {
      total: workedTime + corrections + absences + questions,
      workedTime,
      corrections,
      absences,
      questions,
    };
  });

  const decision = z.object({ decision: z.enum(['approve', 'reject']) });

  r.put(
    '/approvals/worked-time/:id',
    {
      preValidation: planners,
      schema: {
        params: idParam,
        body: decision.extend({
          paidStart: z.string().datetime({ offset: true }).optional(),
          paidEnd: z.string().datetime({ offset: true }).optional(),
          breakMinutes: z.number().int().min(0).max(600).optional(),
          notes: z.string().max(500).optional(),
        }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      return tx((trx) => decideWorkedTime(trx, p, actorOf(req), app.clock(), req.params.id, req.body));
    },
  );

  r.post(
    '/approvals/worked-time/bulk-approve',
    {
      preValidation: planners,
      schema: { body: z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) }) },
    },
    async (req) => {
      const p = getPrincipal(req);
      const approved: number[] = [];
      const failed: Array<{ id: number; code: string; message: string }> = [];
      for (const id of [...new Set(req.body.ids)]) {
        try {
          await tx(async (trx) => {
            const rec = await trx
              .selectFrom('punch_record')
              .selectAll()
              .where('id', '=', id)
              .executeTakeFirst();
            if (!rec) throw notFound('Time record');
            p.scope.assertHotel(rec.hotel_id);
            const vars = await trx
              .selectFrom('time_variation')
              .select(['variation_type', 'status'])
              .where('punch_record_id', '=', id)
              .execute();
            const flags = flagsOf(rec, vars);
            if (flags.length)
              throw new AppError('CONFLICT', 'The record is flagged and needs an individual decision', {
                flags,
              });
            await decideWorkedTime(trx, p, actorOf(req), app.clock(), id, { decision: 'approve' });
          });
          approved.push(id);
        } catch (e) {
          if (e instanceof AppError) failed.push({ id, code: e.code, message: e.message });
          else throw e;
        }
      }
      return { approved, failed };
    },
  );

  r.put(
    '/approvals/corrections/:id',
    {
      preValidation: planners,
      schema: { params: idParam, body: decision.extend({ notes: z.string().max(500).optional() }) },
    },
    async (req) => {
      const p = getPrincipal(req);
      return tx((trx) => decideCorrection(trx, p, actorOf(req), app.clock(), req.params.id, req.body));
    },
  );

  r.put(
    '/approvals/absences/:id',
    {
      preValidation: planners,
      schema: { params: idParam, body: decision.extend({ note: z.string().max(300).optional() }) },
    },
    async (req) => {
      const p = getPrincipal(req);
      return tx((trx) => decideAbsence(trx, p, actorOf(req), app.clock(), req.params.id, req.body));
    },
  );

  // ------------------------------------------------------------------ attendance report
  r.get(
    '/reports/attendance',
    {
      preValidation: planners,
      schema: {
        querystring: z.object({
          hotelId: z.coerce.number().int().positive().optional(),
          from: isoDate,
          to: isoDate,
          flag: z.enum(FLAGS).optional(),
          employeeId: z.coerce.number().int().positive().optional(),
          format: z.enum(['json', 'csv']).default('json'),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const q = req.query;
      const hotelIds = p.scope.hotels(q.hotelId ? [q.hotelId] : undefined);
      const today = await todayFor(hotelIds);
      const items = await listWorkedTime(
        db,
        hotelIds,
        { from: q.from, to: q.to, employeeId: q.employeeId },
        today,
        q.flag,
      );
      const rows = items.map((i) => ({
        date: i.shiftDate,
        employeeId: i.employeeId,
        employee: i.displayName,
        hotelId: i.hotelId,
        plannedStart: i.plannedStart,
        plannedEnd: i.plannedEnd,
        actualIn: i.actualIn,
        actualOut: i.actualOut,
        paidStart: i.paidStart,
        paidEnd: i.paidEnd,
        breakMinutes: i.breakMinutes,
        paidHours: i.paidHours,
        status: i.status,
        flags: i.flags,
      }));
      if (q.format === 'csv') {
        const csv = toCsv(
          [
            'date',
            'employee',
            'hotelId',
            'plannedStart',
            'plannedEnd',
            'actualIn',
            'actualOut',
            'paidStart',
            'paidEnd',
            'breakMinutes',
            'paidHours',
            'status',
            'flags',
          ],
          rows.map((x) => [
            x.date,
            x.employee,
            x.hotelId,
            x.plannedStart,
            x.plannedEnd,
            x.actualIn,
            x.actualOut,
            x.paidStart,
            x.paidEnd,
            x.breakMinutes,
            x.paidHours,
            x.status,
            x.flags.join(','),
          ]),
        );
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="attendance_${q.from}_${q.to}.csv"`)
          .send(csv);
      }
      return { rows, total: rows.length };
    },
  );

  // ------------------------------------------------------------------ payroll periods (month close)
  const periodOut = (x: Selectable<DB['payroll_period']>): PayrollPeriodDto => ({
    id: x.id,
    companyId: x.company_id,
    hotelId: x.hotel_id,
    from: x.period_start,
    to: x.period_end,
    status: x.status,
    closedAt: x.closed_at?.toISOString() ?? null,
    closedByUserId: x.closed_by_user_id,
    reopenReason: x.reopen_reason,
  });

  r.get('/periods', { preValidation: adminsOnly }, async (req) => {
    const p = getPrincipal(req);
    const rows = p.scope.companyIds.length
      ? await db
          .selectFrom('payroll_period')
          .selectAll()
          .where('company_id', 'in', p.scope.companyIds)
          .orderBy('period_start', 'desc')
          .orderBy('id', 'desc')
          .execute()
      : [];
    return { items: rows.map(periodOut) };
  });

  r.post(
    '/periods/close',
    {
      preValidation: adminsOnly,
      schema: {
        body: z
          .object({
            companyId: z.number().int().positive(),
            hotelId: z.number().int().positive().optional(),
            from: isoDate,
            to: isoDate,
          })
          .refine((b) => b.to >= b.from, 'to must not be before from'),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      const b = req.body;
      p.scope.assertCompany(b.companyId);
      return tx(async (trx) => {
        const hotels = await trx
          .selectFrom('hotel')
          .select(['id', 'timezone'])
          .where('company_id', '=', b.companyId)
          .execute();
        if (b.hotelId && !hotels.some((h) => h.id === b.hotelId))
          throw new AppError('VALIDATION', 'The hotel does not belong to the company');
        if (b.hotelId) p.scope.assertHotel(b.hotelId);
        const scoped = b.hotelId ? hotels.filter((h) => h.id === b.hotelId) : hotels;
        const ids = scoped.map((h) => h.id);
        const tz = new Map(scoped.map((h) => [h.id, h.timezone]));
        const pendingRecords = ids.length
          ? await trx
              .selectFrom('punch_record as pr')
              .innerJoin('employee as e', 'e.employee_id', 'pr.employee_id')
              .select(['pr.id', 'pr.shift_date', 'e.display_name', 'pr.actual_punch_out'])
              .where('pr.hotel_id', 'in', ids)
              .where('pr.shift_date', '>=', b.from)
              .where('pr.shift_date', '<=', b.to)
              .where((eb) =>
                eb.or([eb('pr.approval_status', '=', 'pending'), eb('pr.actual_punch_out', 'is', null)]),
              )
              .orderBy('pr.shift_date')
              .execute()
          : [];
        const corrections = ids.length
          ? await trx
              .selectFrom('time_correction_request as c')
              .innerJoin('employee as e', 'e.employee_id', 'c.employee_id')
              .select([
                'c.id',
                'c.hotel_id',
                'c.requested_in',
                'c.requested_out',
                'c.created_at',
                'e.display_name',
              ])
              .where('c.hotel_id', 'in', ids)
              .where('c.status', '=', 'pending')
              .execute()
          : [];
        const pendingCorrections = corrections.filter((c) => {
          const when = c.requested_in ?? c.requested_out ?? c.created_at;
          if (!when) return false;
          const d = localDate(when, tz.get(c.hotel_id) ?? 'Europe/Berlin');
          return d >= b.from && d <= b.to;
        });
        if (pendingRecords.length || pendingCorrections.length)
          throw new AppError('PENDING_APPROVALS', 'There are pending approvals in this period', {
            workedTime: pendingRecords.map((x) => ({
              id: x.id,
              date: x.shift_date,
              employee: x.display_name,
              open: x.actual_punch_out == null,
            })),
            corrections: pendingCorrections.map((x) => ({ id: x.id, employee: x.display_name })),
          });
        const clash = await trx
          .selectFrom('payroll_period')
          .select('id')
          .where('company_id', '=', b.companyId)
          .where('status', '=', 'closed')
          .where('period_start', '<=', b.to)
          .where('period_end', '>=', b.from)
          .where((eb) =>
            b.hotelId ? eb.or([eb('hotel_id', 'is', null), eb('hotel_id', '=', b.hotelId)]) : eb.val(true),
          )
          .executeTakeFirst();
        if (clash)
          throw new AppError('CONFLICT', 'The range overlaps an already closed period', {
            periodId: clash.id,
          });
        const now = app.clock();
        const row = await trx
          .insertInto('payroll_period')
          .values({
            company_id: b.companyId,
            hotel_id: b.hotelId ?? null,
            period_start: b.from,
            period_end: b.to,
            status: 'closed',
            closed_by_user_id: p.userId,
            closed_at: now,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'period_closed',
          entityType: 'payroll_period',
          entityId: row.id,
          companyId: b.companyId,
          hotelId: b.hotelId ?? null,
          new: { from: b.from, to: b.to },
        });
        return periodOut(row);
      });
    },
  );

  r.post(
    '/periods/:id/reopen',
    {
      preValidation: adminsOnly,
      schema: { params: idParam, body: z.object({ reason: z.string().min(5).max(300) }) },
    },
    async (req) => {
      const p = getPrincipal(req);
      return tx(async (trx) => {
        const x = await trx
          .selectFrom('payroll_period')
          .selectAll()
          .where('id', '=', req.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!x) throw notFound('Period');
        p.scope.assertCompany(x.company_id);
        if (x.status !== 'closed') throw new AppError('CONFLICT', 'The period is not closed');
        const row = await trx
          .updateTable('payroll_period')
          .set({ status: 'open', reopened_by_user_id: p.userId, reopen_reason: req.body.reason })
          .where('id', '=', x.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'period_reopened',
          entityType: 'payroll_period',
          entityId: x.id,
          companyId: x.company_id,
          hotelId: x.hotel_id,
          old: { status: 'closed' },
          new: { status: 'open' },
          reason: req.body.reason,
        });
        return periodOut(row);
      });
    },
  );

  // ------------------------------------------------------------------ audit log
  /** Recomputes the hash chains. A company admin checks the own company; the super admin also the global chains. */
  r.get('/audit-log/verify', { preValidation: adminsOnly }, async (req) => {
    const p = getPrincipal(req);
    const result = await verifyAuditChains(db, p.role === 'superAdmin' ? undefined : p.scope.companyIds);
    return {
      ok: result.chains.every((c) => c.ok),
      checkedAt: app.clock().toISOString(),
      chains: result.chains,
      // entries from before per-company chains cannot be verified (see docs/DECISIONS.md)
      unverifiableLegacyRows: p.role === 'superAdmin' ? result.legacyRows : null,
    };
  });

  r.get(
    '/audit-log',
    {
      preValidation: adminsOnly,
      schema: {
        querystring: z.object({
          actor: z.coerce.number().int().optional(),
          action: z.string().max(50).optional(),
          entity: z.string().max(50).optional(),
          from: isoDate.optional(),
          to: isoDate.optional(),
          format: z.enum(['json', 'csv']).default('json'),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(500).default(50),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const q = req.query;
      let qb = db
        .selectFrom('audit_log as a')
        .leftJoin('user_account as u', 'u.id', 'a.actor_id')
        .select([
          'a.id',
          'a.company_id',
          'a.hotel_id',
          'a.actor_id',
          'a.actor_type',
          'a.action',
          'a.entity_type',
          'a.entity_id',
          'a.old_values',
          'a.new_values',
          'a.reason',
          'a.status',
          'a.created_at',
          'u.email as actor_email',
          'u.username as actor_username',
        ])
        // company-bound rows only for the caller's companies; system rows without a company are SA-only
        .where((eb) =>
          p.role === 'superAdmin'
            ? eb.val(true)
            : eb.or([eb('a.company_id', 'in', p.scope.companyIds.length ? p.scope.companyIds : [-1])]),
        );
      if (q.actor) qb = qb.where('a.actor_id', '=', q.actor);
      if (q.action) qb = qb.where('a.action', 'like', `%${q.action.replace(/[%_]/g, '')}%`);
      if (q.entity) qb = qb.where('a.entity_type', '=', q.entity);
      if (q.from) qb = qb.where('a.created_at', '>=', new Date(`${q.from}T00:00:00Z`));
      if (q.to) qb = qb.where('a.created_at', '<', new Date(Date.parse(`${q.to}T00:00:00Z`) + 86400000));
      const out = (
        a: Pick<
          Selectable<DB['audit_log']>,
          | 'id'
          | 'created_at'
          | 'actor_id'
          | 'actor_type'
          | 'action'
          | 'entity_type'
          | 'entity_id'
          | 'company_id'
          | 'hotel_id'
          | 'old_values'
          | 'new_values'
          | 'reason'
        > & { actor_email?: string | null; actor_username?: string | null },
      ) => ({
        id: Number(a.id),
        at: a.created_at?.toISOString() ?? null,
        actorId: a.actor_id,
        actorType: a.actor_type,
        actor: a.actor_email ?? a.actor_username ?? null,
        action: a.action,
        entity: a.entity_type,
        entityId: a.entity_id,
        companyId: a.company_id,
        hotelId: a.hotel_id,
        old: a.old_values,
        new: a.new_values,
        reason: a.reason,
      });
      if (q.format === 'csv') {
        const rows = await qb.orderBy('a.id', 'desc').limit(10000).execute();
        const csv = toCsv(
          [
            'id',
            'at',
            'actorType',
            'actor',
            'action',
            'entity',
            'entityId',
            'hotelId',
            'old',
            'new',
            'reason',
          ],
          rows
            .map(out)
            .map((x) => [
              x.id,
              x.at,
              x.actorType,
              x.actor,
              x.action,
              x.entity,
              x.entityId,
              x.hotelId,
              x.old ? JSON.stringify(x.old) : '',
              x.new ? JSON.stringify(x.new) : '',
              x.reason,
            ]),
        );
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', 'attachment; filename="audit-log.csv"')
          .send(csv);
      }
      const total = await qb
        .clearSelect()
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      const rows = await qb
        .clearSelect()
        .select([
          'a.id',
          'a.company_id',
          'a.hotel_id',
          'a.actor_id',
          'a.actor_type',
          'a.action',
          'a.entity_type',
          'a.entity_id',
          'a.old_values',
          'a.new_values',
          'a.reason',
          'a.status',
          'a.created_at',
          'u.email as actor_email',
          'u.username as actor_username',
        ])
        .orderBy('a.id', 'desc')
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize)
        .execute();
      return { items: rows.map(out), page: q.page, pageSize: q.pageSize, total: Number(total.n) };
    },
  );
  void csvIds;
}
