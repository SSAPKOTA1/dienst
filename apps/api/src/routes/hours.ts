import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DEFAULT_LIMITS, validateCategoryRule, validateLimits, type RuleLimits } from '@dienst/rules';
import { FEATURES } from '@dienst/shared';
import ExcelJS from 'exceljs';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { csvIds, idParam, isoDate } from '../lib/http';
import { toCsv } from '../lib/csv';
import { localDate } from '../lib/time';
import { buildLedger } from '../services/timeAccount';
import { assertPlannerEmployee } from '../services/planning/absence';
import { toBuffer } from '../services/exports';
import {
  buildAnalytics,
  buildPayroll,
  loadCategories,
  replacementRestReport,
  restCompensationReport,
  sundayNightReport,
} from '../services/hours';
import { featureEnabled } from '../services/features';
import type { Db, Trx } from '../db';
import type { Principal } from '../lib/scope';

const planners = requireRole('superAdmin', 'admin', 'manager');
const admins = requireRole('superAdmin', 'admin');
const EM = requireRole('employee');

export async function hoursRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);
  const today = async (hotelId?: number) => {
    const h = hotelId
      ? await db.selectFrom('hotel').select('timezone').where('id', '=', hotelId).executeTakeFirst()
      : undefined;
    return localDate(app.clock(), h?.timezone ?? 'Europe/Berlin');
  };
  const companyOf = (p: Principal, requested?: number) => {
    const id = requested ?? p.scope.companyIds[0];
    if (!id) throw new AppError('FORBIDDEN_SCOPE', 'No company in scope');
    p.scope.assertCompany(id);
    return id;
  };

  // ------------------------------------------------------------------ time account ledger
  const ledgerOut = (l: NonNullable<Awaited<ReturnType<typeof buildLedger>>>) => ({
    asOf: l.asOf,
    balanceHours: l.balanceHours,
    lines: l.lines.map((x) => ({
      month: x.month,
      type: x.type,
      hours: x.hours,
      note: x.note ?? null,
      entryId: x.entryId ?? null,
    })),
  });

  r.get(
    '/employees/:id/time-account/ledger',
    { preValidation: planners, schema: { params: idParam } },
    async (req) => {
      const p = getPrincipal(req);
      const e = await assertPlannerEmployee(db, p, req.params.id);
      if (p.role === 'manager' && !p.scope.canHotel(e.primary_hotel_id))
        throw new AppError('FORBIDDEN_SCOPE', 'Only managers of the home hotel see the time account');
      const l = await buildLedger(db, e.employee_id, await today(e.primary_hotel_id));
      return l ? ledgerOut(l) : { asOf: await today(e.primary_hotel_id), balanceHours: null, lines: [] };
    },
  );

  r.get('/me/time-account/ledger', { preValidation: EM }, async (req) => {
    const p = getPrincipal(req);
    const e = await db
      .selectFrom('employee')
      .select(['employee_id', 'primary_hotel_id'])
      .where('employee_id', '=', p.employeeId ?? -1)
      .executeTakeFirst();
    if (!e) throw notFound('Employee');
    const t = await today(e.primary_hotel_id);
    const l = await buildLedger(db, e.employee_id, t);
    return l ? ledgerOut(l) : { asOf: t, balanceHours: null, lines: [] };
  });

  r.post(
    '/employees/:id/time-account/entries',
    {
      preValidation: admins,
      schema: {
        params: idParam,
        body: z.object({
          date: isoDate,
          type: z.enum(['correction', 'payout']),
          /** a payout is entered as a positive number of hours paid out and stored negative */
          hours: z.number().refine((h) => h !== 0 && Math.abs(h) <= 500, 'hours between -500 and 500, not 0'),
          note: z.string().trim().min(3).max(300),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const e = await assertPlannerEmployee(db, p, req.params.id);
      const b = req.body;
      const hours = b.type === 'payout' ? -Math.abs(b.hours) : b.hours;
      const row = await tx(async (trx) => {
        if ((await buildLedger(trx, e.employee_id, await today(e.primary_hotel_id))) === null)
          throw new AppError('VALIDATION', 'The employee has no time account');
        const x = await trx
          .insertInto('arbeitszeitkonto_entry')
          .values({
            employee_id: e.employee_id,
            entry_date: b.date,
            entry_type: b.type,
            hours,
            note: b.note,
            created_by_user_id: p.userId,
          })
          .returning(['id', 'entry_date', 'entry_type', 'hours'])
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'time_account_entry',
          entityType: 'employee',
          entityId: e.employee_id,
          hotelId: e.primary_hotel_id,
          companyId: e.company_id,
          new: { type: b.type, hours, date: b.date },
          reason: b.note,
        });
        return x;
      });
      return reply
        .status(201)
        .send({ id: row.id, date: row.entry_date, type: row.entry_type, hours: row.hours });
    },
  );

  // ------------------------------------------------------------------ hour categories
  const catOut = (c: any) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    rule: c.rule,
    active: c.active,
    system: c.company_id == null,
  });
  const catBody = z.object({
    code: z.string().regex(/^[a-z][a-z0-9_]{1,29}$/),
    name: z.string().min(1).max(100),
    rule: z.record(z.string(), z.unknown()),
    active: z.boolean().default(true),
  });

  r.get('/hour-categories', { preValidation: planners }, async (req) => {
    const rows = await loadCategories(db, companyOf(getPrincipal(req)));
    return { items: rows.map(catOut) };
  });

  r.post('/hour-categories', { preValidation: admins, schema: { body: catBody } }, async (req, reply) => {
    const p = getPrincipal(req);
    const companyId = companyOf(p);
    const err = validateCategoryRule(req.body.rule);
    if (err) throw new AppError('VALIDATION', `Invalid rule: ${err}`);
    const row = await tx(async (trx) => {
      const dup = await trx
        .selectFrom('hour_category')
        .select('id')
        .where('company_id', '=', companyId)
        .where('code', '=', req.body.code)
        .executeTakeFirst();
      if (dup) throw new AppError('CONFLICT', 'A category with this code already exists');
      const x = await trx
        .insertInto('hour_category')
        .values({
          company_id: companyId,
          code: req.body.code,
          name: req.body.name,
          rule: JSON.stringify(req.body.rule),
          active: req.body.active,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(trx, actorOf(req), {
        action: 'hour_category_created',
        entityType: 'hour_category',
        entityId: x.id,
        companyId,
        new: catOut(x),
      });
      return x;
    });
    return reply.status(201).send(catOut(row));
  });

  r.put(
    '/hour-categories/:id',
    { preValidation: admins, schema: { params: idParam, body: catBody.omit({ code: true }) } },
    async (req) => {
      const p = getPrincipal(req);
      const err = validateCategoryRule(req.body.rule);
      if (err) throw new AppError('VALIDATION', `Invalid rule: ${err}`);
      return tx(async (trx) => {
        const old = await trx
          .selectFrom('hour_category')
          .selectAll()
          .where('id', '=', req.params.id)
          .executeTakeFirst();
        if (!old) throw notFound('Category');
        if (old.company_id == null)
          throw new AppError(
            'CONFLICT',
            'System categories cannot be edited; add a category with the same code to override it',
          );
        p.scope.assertCompany(old.company_id);
        const x = await trx
          .updateTable('hour_category')
          .set({ name: req.body.name, rule: JSON.stringify(req.body.rule), active: req.body.active })
          .where('id', '=', old.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'hour_category_updated',
          entityType: 'hour_category',
          entityId: old.id,
          companyId: old.company_id,
          old: catOut(old),
          new: catOut(x),
        });
        return catOut(x);
      });
    },
  );

  r.delete(
    '/hour-categories/:id',
    { preValidation: admins, schema: { params: idParam } },
    async (req, reply) => {
      const p = getPrincipal(req);
      await tx(async (trx) => {
        const old = await trx
          .selectFrom('hour_category')
          .selectAll()
          .where('id', '=', req.params.id)
          .executeTakeFirst();
        if (!old) throw notFound('Category');
        if (old.company_id == null) throw new AppError('CONFLICT', 'System categories cannot be deleted');
        p.scope.assertCompany(old.company_id);
        await trx.deleteFrom('hour_category').where('id', '=', old.id).execute();
        await audit(trx, actorOf(req), {
          action: 'hour_category_deleted',
          entityType: 'hour_category',
          entityId: old.id,
          companyId: old.company_id,
          old: catOut(old),
        });
      });
      return reply.status(204).send();
    },
  );

  // ------------------------------------------------------------------ payroll export (hours only)
  r.get(
    '/payroll/export',
    {
      preValidation: admins,
      schema: {
        querystring: z.object({
          month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
          hotelIds: csvIds,
          format: z.enum(['json', 'csv', 'xlsx']).default('json'),
          includeOpen: z.enum(['true', 'false']).default('false'),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const q = req.query;
      const hotels = p.scope.hotels(q.hotelIds);
      const t = await today(hotels[0]);
      const data = await buildPayroll(db, hotels, q.month, t);
      // the month must be closed (every hotel's company) unless the caller asks for a preview
      const closed = await db
        .selectFrom('payroll_period as pp')
        .innerJoin('hotel as h', (j) =>
          j
            .on((eb) => eb.or([eb('pp.hotel_id', '=', eb.ref('h.id')), eb('pp.hotel_id', 'is', null)]))
            .onRef('h.company_id', '=', 'pp.company_id'),
        )
        .select('h.id')
        .where('h.id', 'in', hotels.length ? hotels : [-1])
        .where('pp.status', '=', 'closed')
        .where('pp.period_start', '<=', data.from)
        .where('pp.period_end', '>=', data.to)
        .execute();
      const periodClosed = hotels.length > 0 && hotels.every((h) => closed.some((c) => c.id === h));
      if (q.format === 'json') return { ...data, periodClosed };
      if (!periodClosed && q.includeOpen !== 'true')
        throw new AppError('CONFLICT', 'The month is not closed; close it first or export a preview', {
          month: q.month,
        });
      const head = [
        'Personalnummer',
        'Name',
        'Hotel',
        'Arbeitsstunden',
        ...data.categories.map((c) => `Std ${c.name}`),
        ...data.absenceCodes.map((c) => `Tage ${c}`),
        'Zeitkonto Std',
      ];
      const lines = data.rows.map((x) => [
        x.personnelNumber,
        x.name,
        x.hotel,
        x.workedHours,
        ...data.categories.map((c) => x.categoryHours[c.code] ?? 0),
        ...data.absenceCodes.map((c) => x.absenceDays[c] ?? 0),
        x.timeAccountHours ?? '',
      ]);
      const fname = `lohnexport_${q.month}`;
      if (q.format === 'csv')
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="${fname}.csv"`)
          .send(toCsv(head, lines));
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Lohnexport');
      ws.addRow(head).font = { bold: true };
      for (const l of lines) ws.addRow(l);
      head.forEach((_, i) => (ws.getColumn(i + 1).width = i < 3 ? 22 : 14));
      await audit(db, actorOf(req), {
        action: 'payroll_exported',
        entityType: 'company',
        new: { month: q.month, rows: lines.length, periodClosed },
      });
      return reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', `attachment; filename="${fname}.xlsx"`)
        .send(await toBuffer(wb));
    },
  );

  // ------------------------------------------------------------------ compliance
  const range = z.object({ hotelIds: csvIds, from: isoDate, to: isoDate });
  r.get(
    '/compliance/rest-compensation',
    { preValidation: planners, schema: { querystring: range } },
    async (req) => {
      const hotels = getPrincipal(req).scope.hotels(req.query.hotelIds);
      return { items: await restCompensationReport(db, hotels, req.query.from, req.query.to, app.clock()) };
    },
  );
  r.get(
    '/compliance/replacement-rest',
    { preValidation: planners, schema: { querystring: range } },
    async (req) => {
      const hotels = getPrincipal(req).scope.hotels(req.query.hotelIds);
      return {
        items: await replacementRestReport(db, hotels, req.query.from, req.query.to, await today(hotels[0])),
      };
    },
  );
  r.get(
    '/compliance/sundays-nights',
    {
      preValidation: planners,
      schema: {
        querystring: z.object({ hotelIds: csvIds, year: z.coerce.number().int().min(2000).max(2100) }),
      },
    },
    async (req) => {
      const hotels = getPrincipal(req).scope.hotels(req.query.hotelIds);
      return {
        year: req.query.year,
        items: await sundayNightReport(db, hotels, req.query.year, await today(hotels[0])),
      };
    },
  );

  // ------------------------------------------------------------------ rule profiles
  const ruleScope = z.object({
    companyId: z.coerce.number().int().positive().optional(),
    hotelId: z.coerce.number().int().positive().optional(),
  });
  const effective = async (companyId: number, hotelId?: number) => {
    const c = await db
      .selectFrom('company')
      .select('rule_profile_id')
      .where('id', '=', companyId)
      .executeTakeFirstOrThrow();
    const h = hotelId
      ? await db
          .selectFrom('hotel')
          .select(['rule_profile_id', 'company_id'])
          .where('id', '=', hotelId)
          .executeTakeFirst()
      : undefined;
    if (hotelId && (!h || h.company_id !== companyId))
      throw new AppError('VALIDATION', 'The hotel does not belong to the company');
    const id = h?.rule_profile_id ?? c.rule_profile_id;
    const prof = id
      ? await db.selectFrom('rule_profile').selectAll().where('id', '=', id).executeTakeFirst()
      : undefined;
    return {
      profile: prof,
      limits: {
        ...DEFAULT_LIMITS,
        ...((prof?.rules as Partial<RuleLimits> | undefined) ?? {}),
      } as RuleLimits,
    };
  };

  r.get('/settings/rules', { preValidation: planners, schema: { querystring: ruleScope } }, async (req) => {
    const p = getPrincipal(req);
    const companyId = companyOf(p, req.query.companyId);
    if (req.query.hotelId) p.scope.assertHotel(req.query.hotelId);
    const e = await effective(companyId, req.query.hotelId);
    return {
      companyId,
      hotelId: req.query.hotelId ?? null,
      defaults: DEFAULT_LIMITS,
      limits: e.limits,
      customised: !!e.profile,
      profileName: e.profile?.name ?? null,
    };
  });

  r.put(
    '/settings/rules',
    {
      preValidation: admins,
      schema: { querystring: ruleScope, body: z.object({ limits: z.record(z.string(), z.number()) }) },
    },
    async (req) => {
      const p = getPrincipal(req);
      const companyId = companyOf(p, req.query.companyId);
      const errs = validateLimits(req.body.limits as Partial<RuleLimits>);
      if (errs.length)
        throw new AppError('VALIDATION', 'The rules may only be stricter than the statutory baseline', {
          errors: errs,
        });
      if (req.query.hotelId) p.scope.assertHotel(req.query.hotelId);
      return tx(async (trx) => {
        const old = await effective(companyId, req.query.hotelId);
        const prof = await trx
          .insertInto('rule_profile')
          .values({
            company_id: companyId,
            name: req.query.hotelId ? 'Hotel' : 'Unternehmen',
            kind: 'standard',
            rules: JSON.stringify(req.body.limits),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (req.query.hotelId)
          await trx
            .updateTable('hotel')
            .set({ rule_profile_id: prof.id })
            .where('id', '=', req.query.hotelId)
            .execute();
        else
          await trx
            .updateTable('company')
            .set({ rule_profile_id: prof.id })
            .where('id', '=', companyId)
            .execute();
        await audit(trx, actorOf(req), {
          action: 'rule_profile_changed',
          entityType: req.query.hotelId ? 'hotel' : 'company',
          entityId: req.query.hotelId ?? companyId,
          companyId,
          hotelId: req.query.hotelId ?? null,
          old: old.limits,
          new: { ...DEFAULT_LIMITS, ...req.body.limits },
        });
        return {
          companyId,
          hotelId: req.query.hotelId ?? null,
          limits: { ...DEFAULT_LIMITS, ...req.body.limits },
          customised: true,
        };
      });
    },
  );

  r.delete(
    '/settings/rules',
    { preValidation: admins, schema: { querystring: ruleScope } },
    async (req, reply) => {
      const p = getPrincipal(req);
      const companyId = companyOf(p, req.query.companyId);
      await tx(async (trx) => {
        if (req.query.hotelId) {
          p.scope.assertHotel(req.query.hotelId);
          await trx
            .updateTable('hotel')
            .set({ rule_profile_id: null })
            .where('id', '=', req.query.hotelId)
            .execute();
        } else
          await trx
            .updateTable('company')
            .set({ rule_profile_id: null })
            .where('id', '=', companyId)
            .execute();
        await audit(trx, actorOf(req), {
          action: 'rule_profile_reset',
          entityType: req.query.hotelId ? 'hotel' : 'company',
          entityId: req.query.hotelId ?? companyId,
          companyId,
        });
      });
      return reply.status(204).send();
    },
  );

  // ------------------------------------------------------------------ feature toggles
  r.get(
    '/settings/features',
    {
      preValidation: planners,
      schema: { querystring: z.object({ companyId: z.coerce.number().int().positive().optional() }) },
    },
    async (req) => {
      const companyId = companyOf(getPrincipal(req), req.query.companyId);
      const out = [];
      for (const f of FEATURES) out.push({ feature: f, enabled: await featureEnabled(db, companyId, f) });
      return { companyId, items: out };
    },
  );

  r.put(
    '/settings/features',
    {
      preValidation: admins,
      schema: {
        querystring: z.object({ companyId: z.coerce.number().int().positive().optional() }),
        body: z.object({ feature: z.enum(FEATURES), enabled: z.boolean() }),
      },
    },
    async (req) => {
      const p = getPrincipal(req);
      const companyId = companyOf(p, req.query.companyId);
      return tx(async (trx) => {
        const old = await featureEnabled(trx, companyId, req.body.feature);
        await trx
          .insertInto('company_feature')
          .values({
            company_id: companyId,
            feature: req.body.feature,
            enabled: req.body.enabled,
            updated_by_user_id: p.userId,
          })
          .onConflict((oc) =>
            oc.columns(['company_id', 'feature']).doUpdateSet({
              enabled: req.body.enabled,
              updated_by_user_id: p.userId,
              updated_at: app.clock(),
            }),
          )
          .execute();
        await audit(trx, actorOf(req), {
          action: 'feature_toggled',
          entityType: 'company',
          entityId: companyId,
          companyId,
          old: { [req.body.feature]: old },
          new: { [req.body.feature]: req.body.enabled },
        });
        return { companyId, feature: req.body.feature, enabled: req.body.enabled };
      });
    },
  );

  r.get('/me/features', { preValidation: requireRole('ANY') }, async (req) => {
    const p = getPrincipal(req);
    const ids = p.employeeId
      ? [
          (
            await db
              .selectFrom('employee')
              .select('company_id')
              .where('employee_id', '=', p.employeeId)
              .executeTakeFirstOrThrow()
          ).company_id,
        ]
      : p.scope.companyIds.slice(0, 1);
    const out: Record<string, boolean> = {};
    for (const f of FEATURES) {
      out[f] = true;
      for (const c of ids) if (!(await featureEnabled(db, c, f))) out[f] = false;
    }
    return out;
  });

  // ------------------------------------------------------------------ analytics
  r.get(
    '/analytics/summary',
    {
      preValidation: planners,
      schema: { querystring: z.object({ hotelIds: csvIds, from: isoDate, to: isoDate }) },
    },
    async (req) => {
      const hotels = getPrincipal(req).scope.hotels(req.query.hotelIds);
      if (req.query.to < req.query.from) throw new AppError('VALIDATION', 'to must not be before from');
      return buildAnalytics(db as Db, hotels, req.query.from, req.query.to, await today(hotels[0]));
    },
  );
}
