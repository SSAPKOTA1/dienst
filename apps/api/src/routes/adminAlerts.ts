import type { AdminAlertDto, AdminAlertListDto } from '@dienst/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { notFound } from '../lib/errors';
import { getPrincipal, requireRole } from '../lib/auth';
import { idParam } from '../lib/http';
import { ADMIN_ALERT_KINDS } from '../services/adminAlerts';

const admins = requireRole('superAdmin', 'admin');

type Payload = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/**
 * The notification bar of admins and super admins. The alerts are `notification` rows of the caller, created by the
 * attendance job and by the wish and leave request endpoints (services/adminAlerts.ts). Every read is limited to the
 * hotels the caller can reach right now, so an admin whose access was reduced stops seeing the older alerts of
 * the hotels they lost.
 */
export async function adminAlertRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  const mine = (userId: number, hotelIds: number[]) =>
    db
      .selectFrom('notification')
      .where('user_id', '=', userId)
      .where('kind', 'in', [...ADMIN_ALERT_KINDS])
      .where('hotel_id', 'in', hotelIds.length ? hotelIds : [0]);

  r.get(
    '/admin-alerts',
    {
      preValidation: admins,
      schema: {
        querystring: z.object({
          unread: z.enum(['true', 'false']).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (req): Promise<AdminAlertListDto> => {
      const p = getPrincipal(req);
      let qb = mine(p.userId, p.scope.hotelIds)
        .select(['id', 'kind', 'payload', 'hotel_id', 'read_at', 'created_at'])
        .orderBy('id', 'desc')
        .limit(req.query.limit);
      if (req.query.unread === 'true') qb = qb.where('read_at', 'is', null);
      const rows = await qb.execute();
      const unread = await mine(p.userId, p.scope.hotelIds)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('read_at', 'is', null)
        .executeTakeFirstOrThrow();

      const pl = (x: { payload: unknown }) => (x.payload ?? {}) as Payload;
      const ids = (key: string, kinds?: string[]) => [
        ...new Set(
          rows
            .filter((x) => !kinds || kinds.includes(x.kind))
            .map((x) => num(pl(x)[key]))
            .filter((v): v is number => v !== null),
        ),
      ];
      const empIds = ids('employeeId');
      const employees = empIds.length
        ? await db
            .selectFrom('employee')
            .select(['employee_id', 'display_name'])
            .where('employee_id', 'in', empIds)
            .execute()
        : [];
      const hotelIds = [...new Set(rows.map((x) => x.hotel_id!))];
      const hotels = hotelIds.length
        ? await db.selectFrom('hotel').select(['id', 'name']).where('id', 'in', hotelIds).execute()
        : [];
      const leaveIds = ids('timeOffId', ['new_leave_request']);
      const leave = leaveIds.length
        ? await db.selectFrom('time_off').select(['id', 'status']).where('id', 'in', leaveIds).execute()
        : [];
      const outIds = ids('punchRecordId', ['missed_checkout']);
      const stillOpen = outIds.length
        ? await db
            .selectFrom('punch_record')
            .select('id')
            .where('id', 'in', outIds)
            .where('actual_punch_out', 'is', null)
            .execute()
        : [];
      const inIds = ids('scheduleId', ['missed_checkin']);
      const punched = inIds.length
        ? await db
            .selectFrom('punch_record')
            .select('schedule_id')
            .where('schedule_id', 'in', inIds)
            .execute()
        : [];

      const items = rows.map((n): AdminAlertDto => {
        const d = pl(n);
        const empId = num(d.employeeId);
        const leaveStatus =
          n.kind === 'new_leave_request'
            ? (leave.find((l) => l.id === num(d.timeOffId))?.status ?? null)
            : null;
        const refId = num(d.punchRecordId) ?? num(d.scheduleId) ?? num(d.timeOffId) ?? num(d.wishId) ?? null;
        const open =
          n.kind === 'new_leave_request'
            ? leaveStatus === 'pending'
            : n.kind === 'missed_checkout'
              ? stillOpen.some((x) => x.id === num(d.punchRecordId))
              : n.kind === 'missed_checkin'
                ? !punched.some((x) => x.schedule_id === num(d.scheduleId))
                : true;
        return {
          id: n.id,
          kind: n.kind,
          read: !!n.read_at,
          createdAt: n.created_at?.toISOString() ?? null,
          hotelId: n.hotel_id!,
          hotelName: hotels.find((h) => h.id === n.hotel_id)?.name ?? '',
          employeeId: empId,
          employeeName: employees.find((e) => e.employee_id === empId)?.display_name ?? null,
          date: str(d.date),
          from: str(d.from),
          to: str(d.to),
          plannedStart: str(d.plannedStart),
          plannedEnd: str(d.plannedEnd),
          minutes: num(d.minutes),
          refId,
          open,
          status: leaveStatus,
        };
      });
      return { items, unread: Number(unread.n) };
    },
  );

  // Reading is the caller's own state, like PUT /notifications/:id/read: not audited.
  r.put('/admin-alerts/read-all', { preValidation: admins }, async (req) => {
    const p = getPrincipal(req);
    const res = await db
      .updateTable('notification')
      .set({ read_at: app.clock() })
      .where('user_id', '=', p.userId)
      .where('kind', 'in', [...ADMIN_ALERT_KINDS])
      .where('hotel_id', 'in', p.scope.hotelIds.length ? p.scope.hotelIds : [0])
      .where('read_at', 'is', null)
      .executeTakeFirst();
    return { updated: Number(res.numUpdatedRows) };
  });

  r.put('/admin-alerts/:id/read', { preValidation: admins, schema: { params: idParam } }, async (req) => {
    const p = getPrincipal(req);
    const n = await db
      .updateTable('notification')
      .set({ read_at: app.clock() })
      .where('id', '=', req.params.id)
      .where('user_id', '=', p.userId)
      .where('kind', 'in', [...ADMIN_ALERT_KINDS])
      .where('hotel_id', 'in', p.scope.hotelIds.length ? p.scope.hotelIds : [0])
      .returning('id')
      .executeTakeFirst();
    if (!n) throw notFound('Alert');
    return { id: n.id, read: true };
  });
}
