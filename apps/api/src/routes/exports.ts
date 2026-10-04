import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { getPrincipal, requireRole } from '../lib/auth';
import { csvIds, isoDate } from '../lib/http';
import { buildGrid } from '../services/planning/grid';
import { assertPlannerEmployee } from '../services/planning/absence';
import {
  buildTimesheet,
  scheduleWorkbook,
  timesheetPdf,
  timesheetWorkbook,
  toBuffer,
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
