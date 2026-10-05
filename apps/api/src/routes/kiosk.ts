import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withinGrace } from '@dienst/rules';
import { AppError, notFound } from '../lib/errors';
import { audit, type Actor } from '../lib/audit';
import { badgeHash, sha256 } from '../lib/security';
import { signPayload, verifyToken } from '../lib/jwt';
import { breakOptions, computeClose, graceOf, hotelTz, verifyPin, type Device } from '../services/kiosk';
import { breakToggle, closePunch, punchIn, segmentMinutes, type BreakSegment } from '../services/punch';
import { notifyPlanners } from '../services/collab';
import type { Trx } from '../db';

declare module 'fastify' {
  interface FastifyRequest {
    device: Device | null;
  }
}

const TTL = '5m';
const OFFLINE_REF_TTL = '48h';
const OFFLINE_MAX_AGE_MS = 24 * 3600e3;
const onBreak = (segs: unknown): boolean => {
  const a = segs as BreakSegment[] | null;
  return !!a?.length && a[a.length - 1].end == null;
};

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
      .select(['h.name', 'c.pin_length', 'h.break_mode', 'h.kiosk_identification'])
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
        'p.break_segments',
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
        state: onBreak(o.break_segments) ? 'on_break' : 'working',
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
      breakMode: hotel.break_mode,
      identification: hotel.kiosk_identification,
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
        .select(['actual_punch_in', 'actual_punch_out', 'break_segments'])
        .where('employee_id', '=', empId)
        .orderBy('actual_punch_in', 'desc')
        .limit(1)
        .executeTakeFirst();
      return {
        state:
          last && !last.actual_punch_out ? (onBreak(last.break_segments) ? 'on_break' : 'working') : 'not_in',
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
        const { rec } = await punchIn(trx, {
          empId,
          userId: emp.user_id,
          companyId: emp.company_id,
          hotelId: dev.hotelId,
          at: now,
          now,
          source: 'kiosk',
          deviceId: dev.id,
          grace,
          tz,
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
    const mode = (
      await db
        .selectFrom('hotel')
        .select('break_mode')
        .where('id', '=', dev.hotelId)
        .executeTakeFirstOrThrow()
    ).break_mode;
    const recorded =
      mode === 'start_stop' ? segmentMinutes(rec.break_segments as BreakSegment[] | null, now) : null;
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
      recordedBreakMinutes: recorded,
      suggestedBreakMinutes:
        recorded != null ? recorded : Math.max(c.requiredBreak, sched?.planned_break_minutes ?? 0),
      options: [...new Set([...breakOptions(c.requiredBreak), ...(recorded != null ? [recorded] : [])])].sort(
        (a, b) => a - b,
      ),
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
          .select(['id', 'hotel_id', 'employee_id'])
          .where('id', '=', c.rec!)
          .executeTakeFirst();
        if (!rec || rec.hotel_id !== dev.hotelId) throw notFound('Time record');
        const emp = await trx
          .selectFrom('employee')
          .select(['employee_id', 'user_id', 'company_id'])
          .where('employee_id', '=', rec.employee_id)
          .executeTakeFirstOrThrow();
        return closePunch(trx, {
          empId: emp.employee_id,
          userId: emp.user_id,
          companyId: emp.company_id,
          recordId: rec.id,
          hotelId: dev.hotelId,
          outAt,
          now,
          grace: await graceOf(trx, emp.company_id),
          breakMinutes: req.body.actualBreakMinutes,
          reason: req.body.reason,
        });
      });
    },
  );

  // ---------------------------------------------------------------- break start / stop
  async function breakRoute(
    action: 'start' | 'end',
    dev: Device,
    body: { employeeRef: string; pin: string },
  ) {
    const now = app.clock();
    const empId = await readRef(dev, body.employeeRef);
    const emp = await verifyPin(db, empId, body.pin, now);
    const mode = await db
      .selectFrom('hotel')
      .select('break_mode')
      .where('id', '=', dev.hotelId)
      .executeTakeFirstOrThrow();
    if (mode.break_mode !== 'start_stop')
      throw new AppError('CONFLICT', 'Break start/stop is not enabled for this hotel');
    return db.transaction().execute((trx) =>
      breakToggle(trx, {
        empId,
        userId: emp.user_id,
        companyId: emp.company_id,
        hotelId: dev.hotelId,
        at: now,
        action,
      }),
    );
  }
  r.post('/kiosk/break-start', { ...route, schema: { body: pinBody } }, (req) =>
    breakRoute('start', req.device!, req.body),
  );
  r.post('/kiosk/break-end', { ...route, schema: { body: pinBody } }, (req) =>
    breakRoute('end', req.device!, req.body),
  );

  // ---------------------------------------------------------------- badge identification
  r.post(
    '/kiosk/badge',
    { ...route, schema: { body: z.object({ badge: z.string().min(4).max(200) }) } },
    async (req) => {
      const dev = req.device!;
      const h = await db
        .selectFrom('hotel')
        .select('kiosk_identification')
        .where('id', '=', dev.hotelId)
        .executeTakeFirstOrThrow();
      if (h.kiosk_identification !== 'badge_pin') throw notFound('Badge');
      const e = await db
        .selectFrom('employee as e')
        .innerJoin('employee_hotel as eh', 'eh.employee_id', 'e.employee_id')
        .select(['e.employee_id', 'e.display_name'])
        .where('e.badge_hash', '=', badgeHash(app.cfg.TOTP_ENC_KEY, req.body.badge))
        .where('eh.hotel_id', '=', dev.hotelId)
        .where('e.status', '=', 'active')
        .executeTakeFirst();
      if (!e) throw notFound('Badge');
      return { employeeRef: await ref(dev, e.employee_id), displayName: e.display_name };
    },
  );

  // ---------------------------------------------------------------- offline queue
  r.get('/kiosk/offline-roster', route, async (req) => {
    const dev = req.device!;
    const now = app.clock();
    const lo = new Date(now.getTime() - 24 * 3600e3);
    const hi = new Date(now.getTime() + 24 * 3600e3);
    const rows = await db
      .selectFrom('employee as e')
      .innerJoin('employee_hotel as eh', 'eh.employee_id', 'e.employee_id')
      .select(['e.employee_id', 'e.display_name'])
      .where('eh.hotel_id', '=', dev.hotelId)
      .where('e.status', '=', 'active')
      .where((eb) =>
        eb.or([
          eb.exists(
            eb
              .selectFrom('schedule as s')
              .select('s.id')
              .whereRef('s.employee_id', '=', 'e.employee_id')
              .where('s.hotel_id', '=', dev.hotelId)
              .where('s.status', '=', 'published')
              .where('s.planned_start', '<=', hi)
              .where('s.planned_end', '>=', lo),
          ),
          eb.exists(
            eb
              .selectFrom('punch_record as p')
              .select('p.id')
              .whereRef('p.employee_id', '=', 'e.employee_id')
              .where('p.actual_punch_out', 'is', null),
          ),
        ]),
      )
      .orderBy('e.last_name')
      .execute();
    return {
      serverTime: now.toISOString(),
      maxAgeHours: OFFLINE_MAX_AGE_MS / 3600e3,
      items: await Promise.all(
        rows.map(async (e) => ({
          displayName: e.display_name,
          offlineRef: await signPayload(
            app.cfg.JWT_SECRET,
            { kind: 'offref', emp: e.employee_id, dev: dev.id },
            OFFLINE_REF_TTL,
          ),
        })),
      ),
    };
  });

  const offlineItem = z.object({
    clientId: z.string().min(8).max(64),
    action: z.enum(['in', 'out', 'break_start', 'break_end']),
    occurredAt: z.string().datetime({ offset: true }),
    offlineRef: z.string(),
    pin: z.string().min(4).max(8),
    breakMinutes: z.number().int().min(0).max(240).optional(),
    reason: z.string().max(300).optional(),
  });
  r.post(
    '/kiosk/offline-sync',
    { ...route, schema: { body: z.object({ items: z.array(offlineItem).min(1).max(200) }) } },
    async (req) => {
      const dev = req.device!;
      const now = app.clock();
      const items = [...req.body.items].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
      const results: Array<{
        clientId: string;
        status: 'applied' | 'rejected' | 'duplicate';
        code?: string;
      }> = [];
      for (const it of items) {
        const prior = await db
          .selectFrom('offline_punch_log')
          .select(['outcome', 'detail'])
          .where('kiosk_device_id', '=', dev.id)
          .where('client_id', '=', it.clientId)
          .executeTakeFirst();
        if (prior) {
          results.push({ clientId: it.clientId, status: 'duplicate', code: prior.detail ?? undefined });
          continue;
        }
        const at = new Date(it.occurredAt);
        let empId: number | null = null;
        let companyId: number | null = null;
        try {
          if (
            at.getTime() > now.getTime() + 120e3 ||
            now.getTime() - at.getTime() > OFFLINE_MAX_AGE_MS + 3600e3
          )
            throw new AppError('VALIDATION', 'The punch is too old or lies in the future', {
              code: 'OFFLINE_EXPIRED',
            });
          const c = await verifyToken<{ kind?: string; emp?: number; dev?: number }>(
            app.cfg.JWT_SECRET,
            it.offlineRef,
          );
          if (!c || c.kind !== 'offref' || c.dev !== dev.id || !c.emp)
            throw new AppError('UNAUTHENTICATED', 'The offline selection is no longer valid');
          empId = c.emp;
          const emp = await verifyPin(db, empId, it.pin, now);
          companyId = emp.company_id;
          const member = await db
            .selectFrom('employee_hotel')
            .select('hotel_id')
            .where('employee_id', '=', empId)
            .where('hotel_id', '=', dev.hotelId)
            .executeTakeFirst();
          if (!member) throw new AppError('FORBIDDEN_SCOPE', 'This employee does not work at this hotel');
          const tz = await hotelTz(db, dev.hotelId);
          const grace = await graceOf(db, emp.company_id);
          const who = { empId, userId: emp.user_id, companyId: emp.company_id };
          const recordId = await db.transaction().execute(async (trx) => {
            if (it.action === 'in') {
              const { rec } = await punchIn(trx, {
                ...who,
                hotelId: dev.hotelId,
                at,
                now,
                source: 'kiosk_offline',
                deviceId: dev.id,
                grace,
                tz,
              });
              return rec.id;
            }
            if (it.action === 'out') {
              const open = await trx
                .selectFrom('punch_record')
                .select(['id', 'actual_punch_in'])
                .where('employee_id', '=', empId!)
                .where('actual_punch_out', 'is', null)
                .executeTakeFirst();
              if (!open) throw new AppError('NOT_FOUND', 'No open time record');
              if (at <= open.actual_punch_in)
                throw new AppError('VALIDATION', 'Clock-out is before clock-in');
              const res = await closePunch(trx, {
                ...who,
                recordId: open.id,
                hotelId: dev.hotelId,
                outAt: at,
                now,
                grace,
                breakMinutes: it.breakMinutes ?? 0,
                reason: it.reason?.trim() || 'Offline erfasst',
                forceReview: true,
                offline: true,
                source: 'kiosk_offline',
              });
              void res;
              return open.id;
            }
            const b = await breakToggle(trx, {
              ...who,
              hotelId: dev.hotelId,
              at,
              action: it.action === 'break_start' ? 'start' : 'end',
            });
            return b.recordId;
          });
          await db
            .insertInto('offline_punch_log')
            .values({
              kiosk_device_id: dev.id,
              client_id: it.clientId,
              punch_record_id: recordId,
              outcome: 'applied',
            })
            .execute();
          results.push({ clientId: it.clientId, status: 'applied' });
        } catch (e) {
          const code = e instanceof AppError ? e.code : 'INTERNAL';
          if (code === 'INTERNAL') throw e;
          await db.transaction().execute(async (trx) => {
            await trx
              .insertInto('offline_punch_log')
              .values({ kiosk_device_id: dev.id, client_id: it.clientId, outcome: 'rejected', detail: code })
              .execute();
            await audit(
              trx,
              { userId: null, type: 'system' },
              {
                action: 'offline_punch_rejected',
                entityType: 'kiosk_device',
                entityId: dev.id,
                hotelId: dev.hotelId,
                companyId: companyId ?? undefined,
                new: { clientId: it.clientId, action: it.action, occurredAt: it.occurredAt, code },
              },
            );
            await notifyPlanners(trx, dev.hotelId, 'offline_punch_rejected', {
              action: it.action,
              occurredAt: it.occurredAt,
              code,
              deviceName: dev.name,
            });
          });
          results.push({ clientId: it.clientId, status: 'rejected', code });
        }
      }
      return { results };
    },
  );
}
