import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { addDays, mondayOf } from '@dienst/rules';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { idParam, isoDate } from '../lib/http';
import { localDate } from '../lib/time';
import { computeTimeAccount } from '../services/timeAccount';
import { ensureAllowance, remainingDays, vacationSummary } from '../services/vacation';
import { assertNotClosed, vacationDays } from '../services/approvals';
import { reverseAbsence } from '../services/planning/absence';
import { hotelManagerUsers } from '../services/kiosk';
import type { Db, Trx } from '../db';
import type { Principal } from '../lib/scope';

const EM = requireRole('employee');

export async function selfRoutes(app: FastifyInstance) {
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
  const tzOf = async (d: Db | Trx, hotelId: number) =>
    (await d.selectFrom('hotel').select('timezone').where('id', '=', hotelId).executeTakeFirstOrThrow())
      .timezone;
  const range = z.object({ from: isoDate, to: isoDate });

  // ------------------------------------------------------------------ schedule
  r.get('/me/schedule', { preValidation: EM, schema: { querystring: range } }, async (req) => {
    const p = getPrincipal(req);
    const { from, to } = req.query;
    const emp = await myEmployee(db, p);
    const entries = await db
      .selectFrom('schedule as s')
      .innerJoin('hotel as h', 'h.id', 's.hotel_id')
      .leftJoin('shift as sh', 'sh.id', 's.shift_id')
      .select([
        's.id',
        's.shift_date',
        's.planned_start',
        's.planned_end',
        's.planned_break_minutes',
        's.hotel_id',
        'h.name as hotel_name',
        'sh.name as shift_name',
      ])
      .where('s.employee_id', '=', emp.employee_id)
      .where('s.status', '=', 'published')
      .where('s.shift_date', '>=', from)
      .where('s.shift_date', '<=', to)
      .orderBy('s.planned_start')
      .execute();
    const absences = await db
      .selectFrom('time_off')
      .select(['id', 'start_date', 'end_date', 'type', 'status'])
      .where('employee_id', '=', emp.employee_id)
      .where('status', 'in', ['pending', 'approved'])
      .where('start_date', '<=', to)
      .where('end_date', '>=', from)
      .execute();
    return {
      entries: entries.map((e) => ({
        id: e.id,
        date: e.shift_date,
        start: e.planned_start.toISOString(),
        end: e.planned_end.toISOString(),
        breakMinutes: e.planned_break_minutes,
        hotelId: e.hotel_id,
        hotelName: e.hotel_name,
        shiftName: e.shift_name,
        hours:
          Math.round(
            ((e.planned_end.getTime() - e.planned_start.getTime()) / 60000 - e.planned_break_minutes) / 6,
          ) / 10,
      })),
      absences: absences.map((a) => ({
        id: a.id,
        from: a.start_date,
        to: a.end_date,
        type: a.type,
        status: a.status,
      })),
    };
  });

  // ------------------------------------------------------------------ attendance (SPEC 4.8)
  const attendanceItems = async (emp: { employee_id: number }, from: string, to: string) => {
    const rows = await db
      .selectFrom('punch_record as pr')
      .innerJoin('hotel as h', 'h.id', 'pr.hotel_id')
      .select([
        'pr.id',
        'pr.shift_date',
        'pr.planned_start',
        'pr.planned_end',
        'pr.actual_punch_in',
        'pr.actual_punch_out',
        'pr.paid_start',
        'pr.paid_end',
        'pr.actual_break_minutes',
        'pr.paid_hours',
        'pr.approval_status',
        'pr.approval_notes',
        'h.employee_hours_visibility as vis',
      ])
      .where('pr.employee_id', '=', emp.employee_id)
      .where('pr.shift_date', '>=', from)
      .where('pr.shift_date', '<=', to)
      .orderBy('pr.shift_date', 'desc')
      .orderBy('pr.id', 'desc')
      .execute();
    let approvedHours = 0;
    const items = rows.map((x) => {
      const approved = x.approval_status === 'approved';
      if (approved) approvedHours += x.paid_hours ?? 0;
      const open = x.actual_punch_out == null;
      const status = open ? 'open' : x.approval_status;
      if (x.vis === 'after_approval' && !approved && !open)
        return {
          id: x.id,
          date: x.shift_date,
          status,
          hoursHidden: true as const,
          ...(x.approval_status === 'rejected' ? { decisionNote: x.approval_notes } : {}),
        };
      return {
        id: x.id,
        date: x.shift_date,
        status,
        hoursHidden: false as const,
        preliminary: x.approval_status === 'pending' ? true : undefined,
        plannedStart: x.planned_start?.toISOString() ?? null,
        plannedEnd: x.planned_end?.toISOString() ?? null,
        in: x.actual_punch_in.toISOString(),
        out: x.actual_punch_out?.toISOString() ?? null,
        paidStart: x.paid_start?.toISOString() ?? null,
        paidEnd: x.paid_end?.toISOString() ?? null,
        breakMinutes: x.actual_break_minutes,
        paidHours: open ? null : x.paid_hours,
        ...(x.approval_status === 'rejected' ? { decisionNote: x.approval_notes } : {}),
      };
    });
    return { items, approvedHours: Math.round(approvedHours * 100) / 100 };
  };

  r.get('/me/attendance', { preValidation: EM, schema: { querystring: range } }, async (req) => {
    const emp = await myEmployee(db, getPrincipal(req));
    return attendanceItems(emp, req.query.from, req.query.to);
  });

  r.get('/me/attendance/:id/history', { preValidation: EM, schema: { params: idParam } }, async (req) => {
    const emp = await myEmployee(db, getPrincipal(req));
    const rec = await db
      .selectFrom('punch_record as pr')
      .innerJoin('hotel as h', 'h.id', 'pr.hotel_id')
      .select(['pr.id', 'pr.approval_status', 'h.employee_hours_visibility as vis'])
      .where('pr.id', '=', req.params.id)
      .where('pr.employee_id', '=', emp.employee_id)
      .executeTakeFirst();
    if (!rec) throw notFound('Time record');
    if (rec.vis === 'after_approval' && rec.approval_status !== 'approved') return { items: [] };
    const h = await db
      .selectFrom('punch_record_history')
      .selectAll()
      .where('punch_record_id', '=', rec.id)
      .orderBy('id')
      .execute();
    return {
      items: h.map((x) => ({
        at: x.created_at?.toISOString() ?? null,
        by: x.changed_by_role,
        change: x.change_type,
        old: x.old_values,
        new: x.new_values,
        reason: x.reason,
      })),
    };
  });

  // ------------------------------------------------------------------ vacation, time account
  r.get(
    '/me/vacation',
    {
      preValidation: EM,
      schema: { querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }) },
    },
    async (req) => {
      const emp = await myEmployee(db, getPrincipal(req));
      const tz = await tzOf(db, emp.primary_hotel_id);
      const year = req.query.year ?? Number(localDate(app.clock(), tz).slice(0, 4));
      const v = await vacationSummary(db, emp.employee_id, year);
      return { allocated: v.allocated, used: v.used, remaining: v.remaining, year };
    },
  );

  r.get('/me/time-account', { preValidation: EM }, async (req) => {
    const emp = await myEmployee(db, getPrincipal(req));
    const today = localDate(app.clock(), await tzOf(db, emp.primary_hotel_id));
    return {
      employeeId: emp.employee_id,
      asOf: today,
      balanceHours: await computeTimeAccount(db, emp.employee_id, today),
    };
  });

  // ------------------------------------------------------------------ corrections (SPEC 4.7)
  const correctionBody = z
    .object({
      type: z.enum(['missed_in', 'missed_out', 'wrong_time', 'missing_day']),
      punchRecordId: z.number().int().positive().optional(),
      requestedIn: z.string().datetime({ offset: true }).optional(),
      requestedOut: z.string().datetime({ offset: true }).optional(),
      requestedBreakMinutes: z.number().int().min(0).max(600).optional(),
      reason: z.string().trim().min(3).max(500),
    })
    .superRefine((b, c) => {
      const need = (ok: boolean, path: string, message: string) =>
        ok || c.addIssue({ code: 'custom', path: [path], message });
      if (b.type === 'missed_in' || b.type === 'missing_day') {
        need(!!b.requestedIn, 'requestedIn', 'required');
        need(!!b.requestedOut, 'requestedOut', 'required');
      }
      if (b.type === 'missed_out') {
        need(!!b.punchRecordId, 'punchRecordId', 'required');
        need(!!b.requestedOut, 'requestedOut', 'required');
      }
      if (b.type === 'wrong_time') {
        need(!!b.punchRecordId, 'punchRecordId', 'required');
        need(!!b.requestedIn || !!b.requestedOut, 'requestedIn', 'start or end required');
      }
      if (b.requestedIn && b.requestedOut)
        need(
          Date.parse(b.requestedOut) > Date.parse(b.requestedIn),
          'requestedOut',
          'must be after requestedIn',
        );
    });

  const correctionOut = (c: any) => ({
    id: c.id,
    type: c.correction_type,
    punchRecordId: c.punch_record_id,
    requestedIn: c.requested_in?.toISOString() ?? null,
    requestedOut: c.requested_out?.toISOString() ?? null,
    requestedBreakMinutes: c.requested_break_minutes,
    reason: c.reason,
    status: c.status,
    decisionNotes: c.decision_notes,
    createdAt: c.created_at?.toISOString() ?? null,
    decidedAt: c.decided_at?.toISOString() ?? null,
  });

  r.post('/me/corrections', { preValidation: EM, schema: { body: correctionBody } }, async (req, reply) => {
    const p = getPrincipal(req);
    const b = req.body;
    const row = await tx(async (trx) => {
      const emp = await myEmployee(trx, p);
      let hotelId = emp.primary_hotel_id;
      let date: string | null = null;
      if (b.punchRecordId) {
        const rec = await trx
          .selectFrom('punch_record')
          .select(['id', 'hotel_id', 'shift_date'])
          .where('id', '=', b.punchRecordId)
          .where('employee_id', '=', emp.employee_id)
          .executeTakeFirst();
        if (!rec) throw notFound('Time record');
        hotelId = rec.hotel_id;
        date = rec.shift_date;
      }
      const tz = await tzOf(trx, hotelId);
      date ??= localDate(new Date((b.requestedIn ?? b.requestedOut)!), tz);
      await assertNotClosed(trx, emp.company_id, hotelId, date);
      const c = await trx
        .insertInto('time_correction_request')
        .values({
          employee_id: emp.employee_id,
          hotel_id: hotelId,
          punch_record_id: b.punchRecordId ?? null,
          correction_type: b.type,
          requested_in: b.requestedIn ? new Date(b.requestedIn) : null,
          requested_out: b.requestedOut ? new Date(b.requestedOut) : null,
          requested_break_minutes: b.requestedBreakMinutes ?? null,
          reason: b.reason,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      for (const uid of await hotelManagerUsers(trx, hotelId))
        await trx
          .insertInto('notification')
          .values({
            user_id: uid,
            kind: 'correction_requested',
            payload: JSON.stringify({ correctionId: c.id, employeeId: emp.employee_id }),
          })
          .execute();
      await audit(trx, actorOf(req), {
        action: 'correction_requested',
        entityType: 'time_correction_request',
        entityId: c.id,
        hotelId,
        companyId: emp.company_id,
        new: { type: b.type, date },
      });
      return c;
    });
    return reply.status(201).send(correctionOut(row));
  });

  r.get('/me/corrections', { preValidation: EM }, async (req) => {
    const emp = await myEmployee(db, getPrincipal(req));
    const rows = await db
      .selectFrom('time_correction_request')
      .selectAll()
      .where('employee_id', '=', emp.employee_id)
      .orderBy('id', 'desc')
      .limit(200)
      .execute();
    return { items: rows.map(correctionOut) };
  });

  // ------------------------------------------------------------------ vacation requests (SPEC 4.19)
  const requestOut = (t: any) => ({
    id: t.id,
    from: t.start_date,
    to: t.end_date,
    days: t.time_off_days,
    reason: t.reason,
    status: t.status,
    decisionNote: t.decision_note,
    createdAt: t.created_at?.toISOString() ?? null,
  });

  r.post(
    '/me/time-off-requests',
    {
      preValidation: EM,
      schema: { body: z.object({ from: isoDate, to: isoDate, reason: z.string().max(500).optional() }) },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const { from, to, reason } = req.body;
      const row = await tx(async (trx) => {
        const emp = await myEmployee(trx, p);
        if (to < from) throw new AppError('VALIDATION', 'to must not be before from');
        const today = localDate(app.clock(), await tzOf(trx, emp.primary_hotel_id));
        if (from < today) throw new AppError('VALIDATION', 'Requests cannot start in the past');
        const days = await vacationDays(trx, emp.employee_id, from, to);
        if (!days.length) throw new AppError('VALIDATION', 'The range contains no working days');
        const overlap = await trx
          .selectFrom('time_off')
          .select('id')
          .where('employee_id', '=', emp.employee_id)
          .where('status', 'in', ['pending', 'approved'])
          .where('start_date', '<=', to)
          .where('end_date', '>=', from)
          .executeTakeFirst();
        if (overlap)
          throw new AppError('CONFLICT', 'There is already an absence in this range', {
            timeOffId: overlap.id,
          });
        const perYear = new Map<number, number>();
        for (const d of days)
          perYear.set(Number(d.slice(0, 4)), (perYear.get(Number(d.slice(0, 4))) ?? 0) + 1);
        for (const [year, n] of perYear) {
          const rem = remainingDays(await ensureAllowance(trx, emp.employee_id, year));
          if (rem < n)
            throw new AppError('INSUFFICIENT_VACATION', 'Not enough vacation left', {
              remaining: rem,
              days: n,
            });
        }
        const t = await trx
          .insertInto('time_off')
          .values({
            employee_id: emp.employee_id,
            start_date: from,
            end_date: to,
            time_off_days: days.length,
            type: 'annual_leave',
            reason: reason ?? null,
            status: 'pending',
            counts_against_allowance: true,
            credits_hours: true,
            created_by_user_id: p.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        for (const uid of await hotelManagerUsers(trx, emp.primary_hotel_id))
          await trx
            .insertInto('notification')
            .values({
              user_id: uid,
              kind: 'vacation_requested',
              payload: JSON.stringify({ timeOffId: t.id, employeeId: emp.employee_id, from, to }),
            })
            .execute();
        await audit(trx, actorOf(req), {
          action: 'absence_requested',
          entityType: 'time_off',
          entityId: t.id,
          hotelId: emp.primary_hotel_id,
          companyId: emp.company_id,
          new: { from, to, days: days.length },
        });
        return t;
      });
      return reply.status(201).send(requestOut(row));
    },
  );

  r.get('/me/time-off-requests', { preValidation: EM }, async (req) => {
    const emp = await myEmployee(db, getPrincipal(req));
    const rows = await db
      .selectFrom('time_off')
      .selectAll()
      .where('employee_id', '=', emp.employee_id)
      .where('type', '=', 'annual_leave')
      .orderBy('start_date', 'desc')
      .limit(200)
      .execute();
    return { items: rows.map(requestOut) };
  });

  r.delete('/me/time-off-requests/:id', { preValidation: EM, schema: { params: idParam } }, async (req) => {
    const p = getPrincipal(req);
    return tx(async (trx) => {
      const emp = await myEmployee(trx, p);
      const t = await trx
        .selectFrom('time_off')
        .selectAll()
        .where('id', '=', req.params.id)
        .where('employee_id', '=', emp.employee_id)
        .where('type', '=', 'annual_leave')
        .forUpdate()
        .executeTakeFirst();
      if (!t) throw notFound('Request');
      const now = app.clock();
      const today = localDate(now, await tzOf(trx, emp.primary_hotel_id));
      if (t.status === 'pending') {
        await trx
          .updateTable('time_off')
          .set({ status: 'cancelled', updated_at: now })
          .where('id', '=', t.id)
          .execute();
      } else if (t.status === 'approved') {
        if (t.start_date < today)
          throw new AppError('CONFLICT', 'Past vacation cannot be cancelled by the employee');
        for (let d = t.start_date; d <= t.end_date; d = addDays(d, 1))
          await assertNotClosed(trx, emp.company_id, emp.primary_hotel_id, d);
        await reverseAbsence(trx, now, t, emp);
        for (const uid of await hotelManagerUsers(trx, emp.primary_hotel_id))
          await trx
            .insertInto('notification')
            .values({
              user_id: uid,
              kind: 'vacation_cancelled',
              payload: JSON.stringify({
                timeOffId: t.id,
                employeeId: emp.employee_id,
                from: t.start_date,
                to: t.end_date,
              }),
            })
            .execute();
      } else throw new AppError('CONFLICT', 'The request can no longer be cancelled');
      await audit(trx, actorOf(req), {
        action: 'absence_cancelled_by_employee',
        entityType: 'time_off',
        entityId: t.id,
        hotelId: emp.primary_hotel_id,
        companyId: emp.company_id,
        old: { status: t.status },
        new: { status: 'cancelled' },
      });
      return { id: t.id, status: 'cancelled' };
    });
  });

  // ------------------------------------------------------------------ home
  r.get('/me/home', { preValidation: EM }, async (req) => {
    const p = getPrincipal(req);
    const emp = await myEmployee(db, p);
    const now = app.clock();
    const today = localDate(now, await tzOf(db, emp.primary_hotel_id));
    const monday = mondayOf(today);
    const sunday = addDays(monday, 6);
    const next = await db
      .selectFrom('schedule as s')
      .innerJoin('hotel as h', 'h.id', 's.hotel_id')
      .leftJoin('shift as sh', 'sh.id', 's.shift_id')
      .select([
        's.id',
        's.shift_date',
        's.planned_start',
        's.planned_end',
        's.planned_break_minutes',
        'h.name as hotel_name',
        'sh.name as shift_name',
      ])
      .where('s.employee_id', '=', emp.employee_id)
      .where('s.status', '=', 'published')
      .where('s.planned_end', '>', now)
      .orderBy('s.planned_start')
      .limit(5)
      .execute();
    const week = await db
      .selectFrom('schedule')
      .select(['planned_start', 'planned_end', 'planned_break_minutes'])
      .where('employee_id', '=', emp.employee_id)
      .where('status', '=', 'published')
      .where('shift_date', '>=', monday)
      .where('shift_date', '<=', sunday)
      .execute();
    const planned = week.reduce(
      (a, e) =>
        a + ((e.planned_end.getTime() - e.planned_start.getTime()) / 60000 - e.planned_break_minutes) / 60,
      0,
    );
    const worked = await db
      .selectFrom('punch_record')
      .select((eb) => eb.fn.sum<number>('paid_hours').as('h'))
      .where('employee_id', '=', emp.employee_id)
      .where('approval_status', '=', 'approved')
      .where('shift_date', '>=', monday)
      .where('shift_date', '<=', sunday)
      .executeTakeFirst();
    const contract = await db
      .selectFrom('employee_contract')
      .select(['target_hours_per_week', 'target_hours_per_month'])
      .where('employee_id', '=', emp.employee_id)
      .where('valid_from', '<=', today)
      .orderBy('valid_from', 'desc')
      .limit(1)
      .executeTakeFirst();
    const target =
      contract?.target_hours_per_week ??
      (contract?.target_hours_per_month != null ? (contract.target_hours_per_month * 12) / 52 : null);
    const notes = await db
      .selectFrom('notification')
      .select(['id', 'kind', 'payload', 'read_at', 'created_at'])
      .where('user_id', '=', p.userId)
      .where('employee_id', '=', emp.employee_id)
      .orderBy('id', 'desc')
      .limit(5)
      .execute();
    const open = await db
      .selectFrom('punch_record')
      .select('id')
      .where('employee_id', '=', emp.employee_id)
      .where('actual_punch_out', 'is', null)
      .executeTakeFirst();
    return {
      today,
      nextShifts: next.map((s) => ({
        id: s.id,
        date: s.shift_date,
        start: s.planned_start.toISOString(),
        end: s.planned_end.toISOString(),
        breakMinutes: s.planned_break_minutes,
        hotelName: s.hotel_name,
        shiftName: s.shift_name,
      })),
      weekHours: Math.round(Number(worked?.h ?? 0) * 10) / 10,
      weekPlannedHours: Math.round(planned * 10) / 10,
      targetHours: target == null ? null : Math.round(target * 10) / 10,
      vacation: await vacationSummary(db, emp.employee_id, Number(today.slice(0, 4))),
      timeAccount: await computeTimeAccount(db, emp.employee_id, today),
      clockedIn: !!open,
      notifications: notes.map(notifOut),
    };
  });

  // ------------------------------------------------------------------ notifications (any role)
  const notifOut = (n: {
    id: number;
    kind: string;
    payload: unknown;
    read_at: Date | null;
    created_at: Date | null;
  }) => ({
    id: n.id,
    kind: n.kind,
    payload: n.payload,
    read: !!n.read_at,
    createdAt: n.created_at?.toISOString() ?? null,
  });

  r.get(
    '/notifications',
    {
      preValidation: requireRole('ANY'),
      schema: {
        querystring: z.object({
          unread: z.enum(['true', 'false']).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      let qb = db
        .selectFrom('notification')
        .select(['id', 'kind', 'payload', 'read_at', 'created_at'])
        .where('user_id', '=', p.userId)
        .orderBy('id', 'desc')
        .limit(req.query.limit);
      if (req.query.unread === 'true') qb = qb.where('read_at', 'is', null);
      const unread = await db
        .selectFrom('notification')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('user_id', '=', p.userId)
        .where('read_at', 'is', null)
        .executeTakeFirstOrThrow();
      return { items: (await qb.execute()).map(notifOut), unread: Number(unread.n) };
    },
  );

  r.put(
    '/notifications/:id/read',
    { preValidation: requireRole('ANY'), schema: { params: idParam } },
    async (req) => {
      const p = getPrincipal(req);
      const n = await db
        .updateTable('notification')
        .set({ read_at: app.clock() })
        .where('id', '=', req.params.id)
        .where('user_id', '=', p.userId)
        .returning('id')
        .executeTakeFirst();
      if (!n) throw notFound('Notification');
      return { id: n.id, read: true };
    },
  );
}
