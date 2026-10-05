import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { ipInCidrs } from '../lib/net';
import { getPrincipal, requireRole } from '../lib/auth';
import { breakOptions, computeClose, graceOf, hotelTz } from '../services/kiosk';
import { breakToggle, closePunch, punchIn, segmentMinutes, type BreakSegment } from '../services/punch';
import type { Trx } from '../db';

const EM = requireRole('employee');

export async function webPunchRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  async function me(userId: number, employeeId: number | null) {
    if (!employeeId) throw new AppError('FORBIDDEN_SCOPE', 'No employee role selected');
    return db
      .selectFrom('employee')
      .select(['employee_id', 'user_id', 'company_id'])
      .where('employee_id', '=', employeeId)
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();
  }

  /** Hotels of the employee where the web punch is switched on. `networkOk` tells whether this request may punch. */
  async function hotelsFor(empId: number, ip: string) {
    const rows = await db
      .selectFrom('employee_hotel as eh')
      .innerJoin('hotel as h', 'h.id', 'eh.hotel_id')
      .select(['h.id', 'h.name', 'h.web_punch_allowed_cidrs', 'h.break_mode'])
      .where('eh.employee_id', '=', empId)
      .where('h.allow_web_punch', '=', true)
      .where('h.is_active', '=', true)
      .orderBy('h.name')
      .execute();
    return rows.map((h) => ({
      hotelId: h.id,
      name: h.name,
      breakMode: h.break_mode,
      networkOk: ipInCidrs(ip, h.web_punch_allowed_cidrs),
    }));
  }

  r.get('/me/punch', { preValidation: EM }, async (req) => {
    const p = getPrincipal(req);
    const emp = await me(p.userId, p.employeeId);
    const now = app.clock();
    const hotels = await hotelsFor(emp.employee_id, req.ip);
    const open = await db
      .selectFrom('punch_record')
      .selectAll()
      .where('employee_id', '=', emp.employee_id)
      .where('actual_punch_out', 'is', null)
      .executeTakeFirst();
    let openOut = null;
    if (open) {
      const grace = await graceOf(db, emp.company_id);
      const c = computeClose(open, now, grace);
      const mode = hotels.find((h) => h.hotelId === open.hotel_id)?.breakMode;
      const segs = open.break_segments as BreakSegment[] | null;
      const recorded = mode === 'start_stop' ? segmentMinutes(segs, now) : null;
      openOut = {
        hotelId: open.hotel_id,
        source: open.source,
        since: open.actual_punch_in.toISOString(),
        onBreak: !!segs?.length && segs[segs.length - 1].end == null,
        grossMinutes: c.grossMinutes,
        requiredBreakMinutes: c.requiredBreak,
        recordedBreakMinutes: recorded,
        suggestedBreakMinutes: recorded ?? c.requiredBreak,
        options: breakOptions(c.requiredBreak),
      };
    }
    return { enabled: hotels.length > 0, hotels, open: openOut, serverTime: now.toISOString() };
  });

  async function guard(userId: number, employeeId: number | null, hotelId: number, ip: string) {
    const emp = await me(userId, employeeId);
    const h = (await hotelsFor(emp.employee_id, ip)).find((x) => x.hotelId === hotelId);
    if (!h) throw new AppError('FORBIDDEN_SCOPE', 'Web punch is not enabled for this hotel');
    if (!h.networkOk)
      throw new AppError('FORBIDDEN_SCOPE', 'Web punch is only possible from the hotel network', {
        reason: 'NETWORK',
      });
    return emp;
  }

  r.post(
    '/me/punch/in',
    { preValidation: EM, schema: { body: z.object({ hotelId: z.number().int().positive() }) } },
    async (req) => {
      const p = getPrincipal(req);
      const emp = await guard(p.userId, p.employeeId, req.body.hotelId, req.ip);
      const now = app.clock();
      const grace = await graceOf(db, emp.company_id);
      const tz = await hotelTz(db, req.body.hotelId);
      const { rec } = await db.transaction().execute((trx: Trx) =>
        punchIn(trx, {
          empId: emp.employee_id,
          userId: emp.user_id,
          companyId: emp.company_id,
          hotelId: req.body.hotelId,
          at: now,
          now,
          source: 'web',
          deviceId: null,
          grace,
          tz,
          ip: req.ip,
        }),
      );
      return {
        punchRecordId: rec.id,
        clockedInAt: rec.actual_punch_in.toISOString(),
        isUnplanned: rec.is_unplanned,
      };
    },
  );

  r.post(
    '/me/punch/break',
    {
      preValidation: EM,
      schema: { body: z.object({ action: z.enum(['start', 'end']) }) },
    },
    async (req) => {
      const p = getPrincipal(req);
      const emp = await me(p.userId, p.employeeId);
      const open = await db
        .selectFrom('punch_record as pr')
        .innerJoin('hotel as h', 'h.id', 'pr.hotel_id')
        .select(['pr.hotel_id', 'pr.source', 'h.break_mode'])
        .where('pr.employee_id', '=', emp.employee_id)
        .where('pr.actual_punch_out', 'is', null)
        .executeTakeFirst();
      if (!open) throw new AppError('NOT_FOUND', 'No open time record');
      await guard(p.userId, p.employeeId, open.hotel_id, req.ip);
      if (open.break_mode !== 'start_stop')
        throw new AppError('CONFLICT', 'Break start/stop is not enabled for this hotel');
      return db.transaction().execute((trx: Trx) =>
        breakToggle(trx, {
          empId: emp.employee_id,
          userId: emp.user_id,
          companyId: emp.company_id,
          hotelId: open.hotel_id,
          at: app.clock(),
          action: req.body.action,
        }),
      );
    },
  );

  r.post(
    '/me/punch/out',
    {
      preValidation: EM,
      schema: {
        body: z.object({
          breakMinutes: z.number().int().min(0).max(240),
          reason: z.string().max(300).optional(),
        }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      const emp = await me(p.userId, p.employeeId);
      const open = await db
        .selectFrom('punch_record')
        .select(['id', 'hotel_id'])
        .where('employee_id', '=', emp.employee_id)
        .where('actual_punch_out', 'is', null)
        .executeTakeFirst();
      if (!open) throw new AppError('NOT_FOUND', 'No open time record');
      await guard(p.userId, p.employeeId, open.hotel_id, req.ip);
      const now = app.clock();
      return db.transaction().execute(async (trx: Trx) =>
        closePunch(trx, {
          empId: emp.employee_id,
          userId: emp.user_id,
          companyId: emp.company_id,
          recordId: open.id,
          hotelId: open.hotel_id,
          outAt: now,
          now,
          grace: await graceOf(trx, emp.company_id),
          breakMinutes: req.body.breakMinutes,
          reason: req.body.reason,
          forceReview: true,
          source: 'web',
          ip: req.ip,
        }),
      );
    },
  );
}
