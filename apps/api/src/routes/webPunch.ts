import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { ipInCidrs } from '../lib/net';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { sha256 } from '../lib/security';
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

  /** The employee's open time record in the shape of the punch screens, or null. */
  async function openOf(
    emp: { employee_id: number; company_id: number },
    hotels: { hotelId: number; breakMode: string }[],
  ) {
    const now = app.clock();
    const open = await db
      .selectFrom('punch_record')
      .selectAll()
      .where('employee_id', '=', emp.employee_id)
      .where('actual_punch_out', 'is', null)
      .executeTakeFirst();
    if (!open) return null;
    const grace = await graceOf(db, emp.company_id);
    const c = computeClose(open, now, grace);
    const mode = hotels.find((h) => h.hotelId === open.hotel_id)?.breakMode;
    const segs = open.break_segments as BreakSegment[] | null;
    const recorded = mode === 'start_stop' ? segmentMinutes(segs, now) : null;
    return {
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

  r.get('/me/punch', { preValidation: EM }, async (req) => {
    const p = getPrincipal(req);
    const emp = await me(p.userId, p.employeeId);
    const hotels = await hotelsFor(emp.employee_id, req.ip);
    return {
      enabled: hotels.length > 0,
      hotels,
      open: await openOf(emp, hotels),
      serverTime: app.clock().toISOString(),
    };
  });

  // ------------------------------------------------------------------ NFC tags
  // A tag at the hotel entrance replaces the network check: whoever taps it is at the hotel. The tag only carries
  // a random token; the employee is still logged in, and the punch goes to review like every web punch.
  const nfcLimit = { rateLimit: { max: app.cfg.RATE_LIMIT_KIOSK, timeWindow: '1 minute' } };

  async function tagFor(token: string) {
    const tag = await db
      .selectFrom('hotel_nfc_tag as t')
      .innerJoin('hotel as h', 'h.id', 't.hotel_id')
      .select(['t.id', 't.hotel_id', 'h.name', 'h.break_mode'])
      .where('t.token_hash', '=', sha256(token))
      .where('t.revoked_at', 'is', null)
      .where('h.is_active', '=', true)
      .executeTakeFirst();
    if (!tag) throw new AppError('NOT_FOUND', 'This NFC tag is not valid', { reason: 'NFC_TAG' });
    return tag;
  }

  /** The employee must work at the hotel of the tag. */
  async function assertAtHotel(empId: number, hotelId: number) {
    const m = await db
      .selectFrom('employee_hotel')
      .select('hotel_id')
      .where('employee_id', '=', empId)
      .where('hotel_id', '=', hotelId)
      .executeTakeFirst();
    if (!m) throw new AppError('FORBIDDEN_SCOPE', 'You do not work at the hotel of this tag');
  }

  r.post(
    '/me/punch/nfc',
    {
      preValidation: EM,
      config: nfcLimit,
      schema: { body: z.object({ token: z.string().min(10).max(200) }) },
    },
    async (req) => {
      const p = getPrincipal(req);
      const emp = await me(p.userId, p.employeeId);
      const tag = await tagFor(req.body.token);
      await assertAtHotel(emp.employee_id, tag.hotel_id);
      const open = await openOf(emp, [{ hotelId: tag.hotel_id, breakMode: tag.break_mode }]);
      if (open && open.hotelId !== tag.hotel_id)
        throw new AppError('CONFLICT', 'You are clocked in at another hotel', { hotelId: open.hotelId });
      return {
        hotelId: tag.hotel_id,
        hotelName: tag.name,
        breakMode: tag.break_mode,
        open,
        serverTime: app.clock().toISOString(),
      };
    },
  );

  /** The tag that proved presence is part of the trail of the punch. */
  const auditNfc = (
    trx: Trx,
    req: FastifyRequest,
    recordId: number,
    hotelId: number,
    tagId: number,
    direction: 'in' | 'out',
  ) =>
    audit(trx, actorOf(req), {
      action: 'punch_via_nfc',
      entityType: 'punch_record',
      entityId: recordId,
      hotelId,
      new: { tagId, direction },
    });

  /** Checks the employee may punch at this hotel: with a valid tag of the hotel, else from the hotel network. */
  async function guard(
    userId: number,
    employeeId: number | null,
    hotelId: number,
    ip: string,
    nfcToken?: string,
  ) {
    const emp = await me(userId, employeeId);
    if (nfcToken) {
      const tag = await tagFor(nfcToken);
      if (tag.hotel_id !== hotelId)
        throw new AppError('FORBIDDEN_SCOPE', 'This tag belongs to another hotel', {
          reason: 'NFC_OTHER_HOTEL',
        });
      await assertAtHotel(emp.employee_id, hotelId);
      return { emp, tagId: tag.id };
    }
    const h = (await hotelsFor(emp.employee_id, ip)).find((x) => x.hotelId === hotelId);
    if (!h) throw new AppError('FORBIDDEN_SCOPE', 'Web punch is not enabled for this hotel');
    if (!h.networkOk)
      throw new AppError('FORBIDDEN_SCOPE', 'Web punch is only possible from the hotel network', {
        reason: 'NETWORK',
      });
    return { emp, tagId: null as number | null };
  }

  r.post(
    '/me/punch/in',
    {
      preValidation: EM,
      schema: {
        body: z.object({
          hotelId: z.number().int().positive(),
          nfcToken: z.string().min(10).max(200).optional(),
        }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      const { emp, tagId } = await guard(p.userId, p.employeeId, req.body.hotelId, req.ip, req.body.nfcToken);
      const now = app.clock();
      const grace = await graceOf(db, emp.company_id);
      const tz = await hotelTz(db, req.body.hotelId);
      const { rec } = await db.transaction().execute(async (trx: Trx) => {
        const res = await punchIn(trx, {
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
        });
        if (tagId && !res.duplicate) await auditNfc(trx, req, res.rec.id, req.body.hotelId, tagId, 'in');
        return res;
      });
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
      schema: {
        body: z.object({
          action: z.enum(['start', 'end']),
          nfcToken: z.string().min(10).max(200).optional(),
        }),
      },
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
      await guard(p.userId, p.employeeId, open.hotel_id, req.ip, req.body.nfcToken);
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
          nfcToken: z.string().min(10).max(200).optional(),
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
      const { tagId } = await guard(p.userId, p.employeeId, open.hotel_id, req.ip, req.body.nfcToken);
      const now = app.clock();
      return db.transaction().execute(async (trx: Trx) => {
        const res = await closePunch(trx, {
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
        });
        if (tagId) await auditNfc(trx, req, open.id, open.hotel_id, tagId, 'out');
        return res;
      });
    },
  );
}
