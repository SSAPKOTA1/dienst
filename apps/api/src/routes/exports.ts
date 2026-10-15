import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { csvIds, isoDate } from '../lib/http';
import { buildGrid } from '../services/planning/grid';
import { assertPlannerEmployee } from '../services/planning/absence';
import { vacationOverviewFor } from './leave';
import {
  buildTimesheet,
  monthWorkbook,
  scheduleWorkbook,
  timesheetPdf,
  timesheetWorkbook,
  toBuffer,
  vacationWorkbook,
} from '../services/exports';

const planners = requireRole('superAdmin', 'admin', 'manager');
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function exportRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  const send = (reply: FastifyReply, body: Buffer, type: string, filename: string) =>
    reply
      .header('content-type', type)
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(body);

  r.get(
    '/schedule/export',
    {
      preValidation: planners,
      schema: {
        querystring: z.object({
          hotelIds: csvIds,
          departmentIds: csvIds,
          view: z.enum(['employee', 'shift']).default('employee'),
          range: z.enum(['week', 'month']).default('week'),
          from: isoDate,
          format: z.enum(['xlsx']).default('xlsx'),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const q = req.query;
      const grid = await buildGrid(db, p, app.clock(), {
        hotelIds: q.hotelIds ?? [],
        departmentIds: q.departmentIds,
        view: q.view,
        range: q.range,
        from: q.from,
      });
      const names = grid.hotelIds.length
        ? (
            await db
              .selectFrom('hotel')
              .select('name')
              .where('id', 'in', grid.hotelIds)
              .orderBy('id')
              .execute()
          ).map((h) => h.name)
        : [];
      const buf = await toBuffer(scheduleWorkbook(grid, names));
      return send(reply, buf, XLSX, `dienstplan_${grid.from}_${grid.to}.xlsx`);
    },
  );

  const hotelNameMap = async (ids: number[]) =>
    new Map(
      ids.length
        ? (
            await db.selectFrom('hotel').select(['id', 'name']).where('id', 'in', ids).orderBy('id').execute()
          ).map((h) => [h.id, h.name] as [number, string])
        : [],
    );
  const exportedOn = () => app.clock().toISOString().slice(0, 10);

  // Vacation overview of a year as Excel (annual leave only). Same roles and scope as the screen; audited.
  r.get(
    '/vacation/overview/export',
    {
      preValidation: planners,
      schema: {
        querystring: z.object({
          year: z.coerce.number().int().min(2000).max(2100),
          hotelIds: csvIds,
          format: z.enum(['xlsx']).default('xlsx'),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const hotels = p.scope.hotels(req.query.hotelIds);
      if (!hotels.length) throw new AppError('VALIDATION', 'No hotels to export');
      const ov = await vacationOverviewFor(db, app.clock(), hotels, req.query.year);
      const names = await hotelNameMap(hotels);
      const buf = await toBuffer(vacationWorkbook(ov, [...names.values()], exportedOn()));
      await audit(db, actorOf(req), {
        action: 'export_vacation_overview',
        entityType: 'hotel',
        entityId: hotels[0]!,
        new: { year: req.query.year, hotelIds: hotels },
      });
      return send(reply, buf, XLSX, `urlaub_${req.query.year}.xlsx`);
    },
  );

  // Month overview as Excel for analysis. Same roles and scope as the grid; managers get sickness only as "abwesend".
  r.get(
    '/schedule/month/export',
    {
      preValidation: planners,
      schema: {
        querystring: z.object({
          month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM'),
          hotelIds: csvIds,
          format: z.enum(['xlsx']).default('xlsx'),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const q = req.query;
      const grid = await buildGrid(db, p, app.clock(), {
        hotelIds: q.hotelIds ?? [],
        view: 'employee',
        range: 'month',
        from: `${q.month}-01`,
      });
      const names = await hotelNameMap(grid.hotelIds);
      const buf = await toBuffer(monthWorkbook(grid, names, exportedOn(), p.role === 'manager'));
      await audit(db, actorOf(req), {
        action: 'export_month_overview',
        entityType: 'hotel',
        entityId: grid.hotelIds[0] ?? 0,
        new: { month: q.month, hotelIds: grid.hotelIds },
      });
      return send(reply, buf, XLSX, `monatsuebersicht_${q.month}.xlsx`);
    },
  );

  const sheetQuery = z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM'),
    format: z.enum(['pdf', 'xlsx']).default('pdf'),
  });
  const deliver = async (reply: FastifyReply, employeeId: number, month: string, format: 'pdf' | 'xlsx') => {
    const t = await buildTimesheet(db, employeeId, month, app.clock());
    const base = `stundenzettel_${t.employee.name.replace(/[^A-Za-z0-9]+/g, '_')}_${month}`;
    if (format === 'xlsx') return send(reply, await toBuffer(timesheetWorkbook(t)), XLSX, `${base}.xlsx`);
    return send(reply, await timesheetPdf(t), 'application/pdf', `${base}.pdf`);
  };

  r.get(
    '/timesheets',
    {
      preValidation: planners,
      schema: { querystring: sheetQuery.extend({ employeeId: z.coerce.number().int().positive() }) },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const e = await assertPlannerEmployee(db, p, req.query.employeeId);
      return deliver(reply, e.employee_id, req.query.month, req.query.format);
    },
  );

  r.get(
    '/me/timesheet',
    { preValidation: requireRole('employee'), schema: { querystring: sheetQuery } },
    async (req, reply) => {
      const p = getPrincipal(req);
      if (!p.employeeId) throw new AppError('FORBIDDEN_SCOPE', 'No employee role selected');
      return deliver(reply, p.employeeId, req.query.month, req.query.format);
    },
  );
}
