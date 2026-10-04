import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { variationMinutes, withinGrace } from '@dienst/rules';
import { AppError, notFound } from '../lib/errors';
import { audit, type Actor } from '../lib/audit';
import { sha256 } from '../lib/security';
import { signPayload, verifyToken } from '../lib/jwt';
import { localDate } from '../lib/time';
import {
  breakOptions,
  computeClose,
  graceOf,
  hotelTz,
  matchSchedule,
  paidFor,
  verifyPin,
  type Device,
} from '../services/kiosk';
import type { Trx } from '../db';

declare module 'fastify' {
  interface FastifyRequest {
    device: Device | null;
  }
}

const TTL = '5m';

export async function kioskRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  app.decorateRequest('device', null);

  async function kioskAuth(req: FastifyRequest) {
    const tok = req.headers['x-kiosk-token'];
    if (typeof tok !== 'string' || !tok) throw new AppError('DEVICE_INVALID', 'Unknown device');
    const d = await db
      .selectFrom('kiosk_device')
      .select(['id', 'hotel_id', 'name', 'status'])
      .where('token_hash', '=', sha256(tok))
      .executeTakeFirst();
    if (!d || d.status !== 'active')
      throw new AppError('DEVICE_INVALID', 'Device is not registered or was revoked');
    req.device = { id: d.id, hotelId: d.hotel_id, name: d.name };
    await db.updateTable('kiosk_device').set({ last_seen_at: app.clock() }).where('id', '=', d.id).execute();
  }
  const limit = {
    rateLimit: {
      max: app.cfg.RATE_LIMIT_KIOSK,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) => String(req.headers['x-kiosk-token'] ?? req.ip),
    },
  };
  const route = { preValidation: kioskAuth, config: limit };

  const ref = (device: Device, empId: number) =>
    signPayload(app.cfg.JWT_SECRET, { kind: 'empref', emp: empId, dev: device.id }, TTL);
  async function readRef(device: Device, token: string): Promise<number> {
    const c = await verifyToken<{ kind?: string; emp?: number; dev?: number }>(app.cfg.JWT_SECRET, token);
    if (!c || c.kind !== 'empref' || c.dev !== device.id || !c.emp)
      throw new AppError('UNAUTHENTICATED', 'The selection expired. Please choose your name again.');
    return c.emp;
  }
  const actorFor = (userId: number): Actor => ({ userId, type: 'employee' });

  r.post('/kiosk/heartbeat', { preValidation: kioskAuth, config: limit }, async (req) => ({
    serverTime: app.clock().toISOString(),
    device: { id: req.device!.id, name: req.device!.name },
  }));

  // ---------------------------------------------------------------- roster and search
  r.get('/kiosk/roster', route, async (req) => {
    const dev = req.device!;
    const now = app.clock();
    const tz = await hotelTz(db, dev.hotelId);
    const hotel = await db
      .selectFrom('hotel as h')
      .innerJoin('company as c', 'c.id', 'h.company_id')
      .select(['h.name', 'c.pin_length'])
      .where('h.id', '=', dev.hotelId)
      .executeTakeFirstOrThrow();
    const lo = new Date(now.getTime() - 2 * 3600e3);
    const hi = new Date(now.getTime() + 2 * 3600e3);
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
      .where('s.hotel_id', '=', dev.hotelId)
      .where('s.status', '=', 'published')
      .where('e.status', '=', 'active')
      .where('s.planned_start', '<=', hi)
      .where('s.planned_end', '>=', lo)
      .execute();
    const open = await db
      .selectFrom('punch_record as p')
      .innerJoin('employee as e', 'e.employee_id', 'p.employee_id')
      .innerJoin('department as pd', 'pd.id', 'e.primary_department_id')
      .select([
        'p.id',
        'p.employee_id',
        'p.schedule_id',
        'p.planned_start',
        'p.planned_end',
        'e.display_name',
        'pd.name as pdept',
      ])
      .where('p.hotel_id', '=', dev.hotelId)
      .where('p.actual_punch_out', 'is', null)
      .execute();
    const punched = entries.length
      ? await db
          .selectFrom('punch_record')
          .select(['schedule_id'])
          .where(
            'schedule_id',
            'in',
            entries.map((e) => e.id),
          )
          .where('approval_status', '<>', 'rejected')
          .execute()
      : [];
    const done = new Set(punched.map((p) => p.schedule_id));
    const openEmp = new Set(open.map((o) => o.employee_id));
    const byEmp = new Map<number, any>();
    for (const o of open) {
      byEmp.set(o.employee_id, {
        employeeId: o.employee_id,
        displayName: o.display_name,
        departmentName: o.pdept,
        plannedStart: o.planned_start?.toISOString() ?? null,
        plannedEnd: o.planned_end?.toISOString() ?? null,
        state: 'working',
      });
    }
    entries.sort(
      (a, b) =>
        Math.abs(a.planned_start.getTime() - now.getTime()) -
        Math.abs(b.planned_start.getTime() - now.getTime()),
    );
    for (const e of entries) {
      if (openEmp.has(e.employee_id)) continue;
      const state = done.has(e.id) ? 'done' : 'not_in';
      const cur = byEmp.get(e.employee_id);
      if (cur && (cur.state === 'not_in' || state === 'done')) continue;
      byEmp.set(e.employee_id, {
        employeeId: e.employee_id,
        displayName: e.display_name,
        departmentName: e.dept ?? e.pdept,
        plannedStart: e.planned_start.toISOString(),
        plannedEnd: e.planned_end.toISOString(),
        state,
      });
    }
    const items = [];
    for (const v of byEmp.values()) {
      const { employeeId, ...rest } = v;
      items.push({ employeeRef: await ref(dev, employeeId), ...rest });
    }
    items.sort(
      (a, b) =>
        (a.plannedStart ?? '').localeCompare(b.plannedStart ?? '') ||
        a.displayName.localeCompare(b.displayName),
    );
    return {
      serverTime: now.toISOString(),
      timezone: tz,
      hotelId: dev.hotelId,
      hotelName: hotel.name,
      deviceName: dev.name,
      pinLength: hotel.pin_length,
      items,
    };
  });

  r.get(
    '/kiosk/search',
    { ...route, schema: { querystring: z.object({ q: z.string().min(2).max(60) }) } },
    async (req) => {
      const like = `%${req.query.q.replace(/[%_]/g, '')}%`;
      const rows = await db
        .selectFrom('employee_hotel as eh')
        .innerJoin('employee as e', 'e.employee_id', 'eh.employee_id')
        .select(['e.employee_id', 'e.display_name'])
        .where('eh.hotel_id', '=', req.device!.hotelId)
        .where('e.status', '=', 'active')
        .where((eb) => eb.or([eb('e.first_name', 'ilike', like), eb('e.last_name', 'ilike', like)]))
        .orderBy('e.last_name')
        .limit(5)
        .execute();
      return {
        items: await Promise.all(
          rows.map(async (e) => ({
            employeeRef: await ref(req.device!, e.employee_id),
            displayName: e.display_name,
          })),
        ),
      };
    },
  );

  r.get(
    '/kiosk/punch-status',
    { ...route, schema: { querystring: z.object({ employeeRef: z.string() }) } },
    async (req) => {
      const empId = await readRef(req.device!, req.query.employeeRef);
      const last = await db
        .selectFrom('punch_record')
        .select(['actual_punch_in', 'actual_punch_out'])
        .where('employee_id', '=', empId)
        .orderBy('actual_punch_in', 'desc')
        .limit(1)
        .executeTakeFirst();
      return {
        state: last && !last.actual_punch_out ? 'working' : 'not_in',
        lastPunchAt: (last?.actual_punch_out ?? last?.actual_punch_in)?.toISOString() ?? null,
      };
    },
  );

  // ---------------------------------------------------------------- clock in
  const pinBody = z.object({ employeeRef: z.string(), pin: z.string().min(4).max(8) });

  async function inResponse(rec: any, grace: number, dev: Device) {
    const minutes = rec.start_variation_minutes;
    const within = minutes == null ? false : withinGrace(minutes, grace);
    return {
      punchRecordId: rec.id,
      clockedInAt: rec.actual_punch_in.toISOString(),
      isUnplanned: rec.is_unplanned,
      variation: { minutes: minutes ?? 0, withinGrace: rec.is_unplanned ? false : within },
      reasonRequired: rec.is_unplanned || !within,
      confirmToken: await signPayload(app.cfg.JWT_SECRET, { kind: 'in', rec: rec.id, dev: dev.id }, TTL),
    };
  }

  r.post('/kiosk/punch-in', { ...route, schema: { body: pinBody } }, async (req) => {
    const dev = req.device!;
    const now = app.clock();
    const empId = await readRef(dev, req.body.employeeRef);
    const emp = await verifyPin(db, empId, req.body.pin, now);
    const member = await db
      .selectFrom('employee_hotel')
      .select('hotel_id')
      .where('employee_id', '=', empId)
      .where('hotel_id', '=', dev.hotelId)
      .executeTakeFirst();
    if (!member) throw new AppError('FORBIDDEN_SCOPE', 'This employee does not work at this hotel');
    const grace = await graceOf(db, emp.company_id);
    const tz = await hotelTz(db, dev.hotelId);
    try {
      return await db.transaction().execute(async (trx) => {
        const open = await trx
          .selectFrom('punch_record')
          .selectAll()
          .where('employee_id', '=', empId)
          .where('actual_punch_out', 'is', null)
          .executeTakeFirst();
        if (open) {
          if (now.getTime() - open.actual_punch_in.getTime() < 60e3) return inResponse(open, grace, dev); // idempotent double tap
          throw new AppError('ALREADY_CLOCKED_IN', 'Already clocked in', {
            since: open.actual_punch_in.toISOString(),
          });
        }
        const match = await matchSchedule(trx, dev.hotelId, empId, now);
        const shiftDate = localDate(match ? match.planned_start : now, tz);
        const closed = await trx
          .selectFrom('payroll_period')
          .select('id')
          .where('company_id', '=', emp.company_id)
          .where('status', '=', 'closed')
          .where('period_start', '<=', shiftDate)
          .where('period_end', '>=', shiftDate)
          .where((eb) => eb.or([eb('hotel_id', 'is', null), eb('hotel_id', '=', dev.hotelId)]))
          .executeTakeFirst();
        if (closed) throw new AppError('PERIOD_CLOSED', 'The payroll period is closed');
        let variation: number | null = null;
        let paidStart = now;
        let outside = false;
        if (match) {
          variation = variationMinutes(now.toISOString(), match.planned_start.toISOString());
          outside = !withinGrace(variation, grace);
          if (!outside) paidStart = match.planned_start;
        }
        const rec = await trx
          .insertInto('punch_record')
          .values({
            employee_id: empId,
            hotel_id: dev.hotelId,
            schedule_id: match?.id ?? null,
            is_unplanned: !match,
            shift_date: shiftDate,
            source: 'kiosk',
            kiosk_device_id: dev.id,
            planned_start: match?.planned_start ?? null,
            planned_end: match?.planned_end ?? null,
            actual_punch_in: now,
            paid_start: paidStart,
            start_variation_minutes: variation,
            approval_status: 'pending',
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        if (!match || outside) {
          await trx
            .insertInto('time_variation')
            .values({
              punch_record_id: rec.id,
              employee_id: empId,
              hotel_id: dev.hotelId,
              variation_type: !match ? 'unplanned' : variation! < 0 ? 'clock_in_early' : 'clock_in_late',
              planned_time: match?.planned_start ?? null,
              actual_time: now,
              variation_minutes: variation,
            })
            .execute();
        }
        await trx
          .insertInto('punch_record_history')
          .values({
            punch_record_id: rec.id,
            changed_by_user_id: emp.user_id,
            changed_by_role: 'employee',
            change_type: 'clock_in',
            new_values: JSON.stringify({ actual_punch_in: now.toISOString(), unplanned: !match }),
          })
          .execute();
        await audit(trx, actorFor(emp.user_id), {
          action: 'punch_in',
          entityType: 'punch_record',
          entityId: rec.id,
          hotelId: dev.hotelId,
          companyId: emp.company_id,
          new: { deviceId: dev.id, unplanned: !match, variationMinutes: variation },
        });
        return inResponse(rec, grace, dev);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        const open = await db
          .selectFrom('punch_record')
          .selectAll()
          .where('employee_id', '=', empId)
          .where('actual_punch_out', 'is', null)
          .executeTakeFirst();
        if (open) return inResponse(open, grace, dev);
      }
      throw e;
    }
  });

  r.post(
    '/kiosk/punch/reason',
    {
      ...route,
      schema: { body: z.object({ confirmToken: z.string(), reason: z.string().min(1).max(300) }) },
    },
    async (req) => {
      const c = await verifyToken<{ kind?: string; rec?: number; dev?: number }>(
        app.cfg.JWT_SECRET,
        req.body.confirmToken,
      );
      if (!c || c.kind !== 'in' || c.dev !== req.device!.id)
        throw new AppError('UNAUTHENTICATED', 'The confirmation expired');
      await db.transaction().execute(async (trx) => {
        const rec = await trx
          .selectFrom('punch_record')
          .select(['id', 'employee_id'])
          .where('id', '=', c.rec!)
          .executeTakeFirstOrThrow();
        const n = await trx
          .updateTable('time_variation')
          .set({ reason: req.body.reason.trim() })
          .where('punch_record_id', '=', rec.id)
          .where('reason', 'is', null)
          .where('variation_type', 'in', ['clock_in_early', 'clock_in_late', 'unplanned'])
          .returning('id')
          .execute();
        const emp = await trx
          .selectFrom('employee')
          .select('user_id')
          .where('employee_id', '=', rec.employee_id)
          .executeTakeFirstOrThrow();
        await audit(trx, actorFor(emp.user_id), {
          action: 'punch_reason',
          entityType: 'punch_record',
          entityId: rec.id,
          hotelId: req.device!.hotelId,
          new: { variations: n.length },
        });
      });
      return { status: 'ok' };
    },
  );

  // ---------------------------------------------------------------- clock out (two steps)
  r.post('/kiosk/punch-out', { ...route, schema: { body: pinBody } }, async (req) => {
    const dev = req.device!;
    const now = app.clock();
    const empId = await readRef(dev, req.body.employeeRef);
    const emp = await verifyPin(db, empId, req.body.pin, now);
    const rec = await db
      .selectFrom('punch_record')
      .selectAll()
      .where('employee_id', '=', empId)
      .where('actual_punch_out', 'is', null)
      .executeTakeFirst();
    if (!rec || rec.hotel_id !== dev.hotelId) throw notFound('Open time record');
    const grace = await graceOf(db, emp.company_id);
    const c = computeClose(rec, now, grace);
    const sched = rec.schedule_id
      ? await db
          .selectFrom('schedule')
          .select('planned_break_minutes')
          .where('id', '=', rec.schedule_id)
          .executeTakeFirst()
      : null;
    return {
      status: 'awaiting_break_confirmation',
      confirmToken: await signPayload(
        app.cfg.JWT_SECRET,
        { kind: 'out', rec: rec.id, dev: dev.id, outAt: now.toISOString() },
        TTL,
      ),
      grossMinutes: c.grossMinutes,
      requiredBreakMinutes: c.requiredBreak,
      plannedBreakMinutes: sched?.planned_break_minutes ?? null,
      suggestedBreakMinutes: Math.max(c.requiredBreak, sched?.planned_break_minutes ?? 0),
      options: breakOptions(c.requiredBreak),
    };
  });

  r.post(
    '/kiosk/punch-out/confirm-break',
    {
      ...route,
      schema: {
        body: z.object({
          confirmToken: z.string(),
          actualBreakMinutes: z.number().int().min(0).max(240),
          reason: z.string().max(300).optional(),
        }),
      },
    },
    async (req) => {
      const dev = req.device!;
      const now = app.clock();
      const c = await verifyToken<{ kind?: string; rec?: number; dev?: number; outAt?: string }>(
        app.cfg.JWT_SECRET,
        req.body.confirmToken,
      );
      if (!c || c.kind !== 'out' || c.dev !== dev.id || !c.rec || !c.outAt)
        throw new AppError('UNAUTHENTICATED', 'The confirmation expired. Please clock out again.');
      const outAt = new Date(c.outAt);
      return db.transaction().execute(async (trx: Trx) => {
        const rec = await trx
          .selectFrom('punch_record')
          .selectAll()
          .where('id', '=', c.rec!)
          .forUpdate()
          .executeTakeFirst();
        if (!rec || rec.hotel_id !== dev.hotelId) throw notFound('Time record');
        const emp = await trx
          .selectFrom('employee')
          .select(['employee_id', 'user_id', 'company_id'])
          .where('employee_id', '=', rec.employee_id)
          .executeTakeFirstOrThrow();
        if (rec.actual_punch_out) {
          if (rec.actual_punch_out.getTime() === outAt.getTime())
            return {
              status: rec.under_break_warning ? 'clocked_out_with_warning' : 'clocked_out',
              paidHours: rec.paid_hours ?? 0,
              approvalStatus: rec.approval_status,
            }; // idempotent confirm
          throw new AppError('CONFLICT', 'The record is already closed');
        }
        const grace = await graceOf(trx, emp.company_id);
        const cl = computeClose(rec, outAt, grace);
        const brk = req.body.actualBreakMinutes;
        const under = brk < cl.requiredBreak;
        if (under && !(req.body.reason && req.body.reason.trim().length > 0))
          throw new AppError(
            'REASON_REQUIRED',
            'A reason is required when the break is shorter than required',
            { requiredBreakMinutes: cl.requiredBreak },
          );
        const closedPeriod = await trx
          .selectFrom('payroll_period')
          .select('id')
          .where('company_id', '=', emp.company_id)
          .where('status', '=', 'closed')
          .where('period_start', '<=', rec.shift_date)
          .where('period_end', '>=', rec.shift_date)
          .executeTakeFirst();
        if (closedPeriod) throw new AppError('PERIOD_CLOSED', 'The payroll period is closed');
        const startOutside =
          rec.is_unplanned ||
          (rec.start_variation_minutes != null && !withinGrace(rec.start_variation_minutes, grace));
        const flagged = startOutside || cl.outsideGrace || under;
        const hours = paidFor(cl.paidStart, cl.paidEnd, brk);
        await trx
          .updateTable('punch_record')
          .set({
            actual_punch_out: outAt,
            paid_start: cl.paidStart,
            paid_end: cl.paidEnd,
            end_variation_minutes: cl.endVariation,
            required_break_minutes: cl.requiredBreak,
            actual_break_minutes: brk,
            paid_hours: hours,
            under_break_warning: under,
            approval_status: flagged ? 'pending' : 'approved',
            approval_source: flagged ? null : 'auto',
            approved_at: flagged ? null : now,
            updated_at: now,
          })
          .where('id', '=', rec.id)
          .execute();
        if (cl.outsideGrace) {
          await trx
            .insertInto('time_variation')
            .values({
              punch_record_id: rec.id,
              employee_id: rec.employee_id,
              hotel_id: rec.hotel_id,
              variation_type: cl.endVariation! < 0 ? 'clock_out_early' : 'clock_out_late',
              planned_time: rec.planned_end,
              actual_time: outAt,
              variation_minutes: cl.endVariation,
              reason: req.body.reason?.trim() ?? null,
            })
            .execute();
        }
        if (under)
          await trx
            .updateTable('time_variation')
            .set({ reason: req.body.reason!.trim() })
            .where('punch_record_id', '=', rec.id)
            .where('reason', 'is', null)
            .execute();
        await trx
          .insertInto('punch_record_history')
          .values({
            punch_record_id: rec.id,
            changed_by_user_id: emp.user_id,
            changed_by_role: 'employee',
            change_type: 'clock_out',
            new_values: JSON.stringify({
              actual_punch_out: outAt.toISOString(),
              actual_break_minutes: brk,
              paid_hours: hours,
            }),
            reason: req.body.reason?.trim() ?? null,
          })
          .execute();
        await audit(trx, actorFor(emp.user_id), {
          action: 'punch_out',
          entityType: 'punch_record',
          entityId: rec.id,
          hotelId: rec.hotel_id,
          companyId: emp.company_id,
          new: { paidHours: hours, breakMinutes: brk, flagged, underBreak: under },
          reason: req.body.reason?.trim() ?? null,
        });
        void now;
        return {
          status: under ? 'clocked_out_with_warning' : 'clocked_out',
          paidHours: hours,
          approvalStatus: flagged ? 'pending' : 'approved',
        };
      });
    },
  );
}
