import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { pageQuery, paged } from '../lib/http';
import { loadAvailableRoles } from '../services/accounts';

const SA = 'superAdmin' as const;
const AD = 'admin' as const;

export async function setupRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  // ---- users & roles list --------------------------------------------------------------------
  r.get(
    '/users',
    {
      preValidation: requireRole(AD, SA),
      schema: { querystring: pageQuery.extend({ q: z.string().max(100).optional() }) },
    },
    async (req) => {
      const p = getPrincipal(req);
      const cs = p.scope.companyIds.length ? p.scope.companyIds : [0];
      const hs = p.scope.hotelIds.length ? p.scope.hotelIds : [0];
      const ids = new Set<number>();
      if (p.role === 'superAdmin') {
        for (const t of ['super_admin', 'admin', 'manager', 'employee'] as const) {
          (await db.selectFrom(t).select('user_id').execute()).forEach((x) => ids.add(x.user_id));
        }
      } else {
        (await db.selectFrom('employee').select('user_id').where('company_id', 'in', cs).execute()).forEach(
          (x) => ids.add(x.user_id),
        );
        (
          await db
            .selectFrom('manager as m')
            .innerJoin('manager_hotel as mh', 'mh.manager_id', 'm.manager_id')
            .select('m.user_id')
            .where('mh.hotel_id', 'in', hs)
            .execute()
        ).forEach((x) => ids.add(x.user_id));
        (
          await db
            .selectFrom('admin as a')
            .innerJoin('admin_company as ac', 'ac.admin_id', 'a.admin_id')
            .select('a.user_id')
            .where('ac.company_id', 'in', cs)
            .execute()
        ).forEach((x) => ids.add(x.user_id));
      }
      const list = ids.size
        ? await db
            .selectFrom('user_account')
            .select(['id', 'email', 'username', 'status', 'last_login_at'])
            .where('id', 'in', [...ids])
            .execute()
        : [];
      const rows = [];
      for (const u of list) {
        const { roles, name } = await loadAvailableRoles(db, u.id);
        rows.push({
          userId: u.id,
          name,
          login: u.email ?? u.username,
          roles: roles.map((x) => ({
            role: x.role,
            hotelNames: x.hotelNames ?? [],
            companyName: x.companyName,
          })),
          lastLoginAt: u.last_login_at,
          status: u.status,
        });
      }
      const q = req.query.q?.toLowerCase();
      const filtered = rows
        .filter((x) => !q || x.name.toLowerCase().includes(q) || (x.login ?? '').toLowerCase().includes(q))
        .sort((a, b) => a.name.localeCompare(b.name));
      const { page, pageSize } = req.query;
      return paged(filtered.slice((page - 1) * pageSize, page * pageSize), page, pageSize, filtered.length);
    },
  );

  // ---- onboarding checklist ------------------------------------------------------------------
  const companyOf = async (req: any, requested?: number) => {
    const p = getPrincipal(req);
    const id = requested ?? p.scope.companyIds[0];
    if (!id) throw new AppError('NOT_FOUND', 'No company in scope');
    p.scope.assertCompany(id);
    return id;
  };

  r.get(
    '/setup/status',
    {
      preValidation: requireRole(AD, SA),
      schema: { querystring: z.object({ companyId: z.coerce.number().int().optional() }) },
    },
    async (req) => {
      const companyId = await companyOf(req, req.query.companyId);
      const hotels = await db.selectFrom('hotel').select('id').where('company_id', '=', companyId).execute();
      const hotelIds = hotels.map((h) => h.id);
      const hs = hotelIds.length ? hotelIds : [0];
      const depts = Number(
        (
          await db
            .selectFrom('department')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('hotel_id', 'in', hs)
            .executeTakeFirstOrThrow()
        ).n,
      );
      const emps = Number(
        (
          await db
            .selectFrom('employee')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('company_id', '=', companyId)
            .where('status', '=', 'active')
            .executeTakeFirstOrThrow()
        ).n,
      );
      const neverIn = Number(
        (
          await db
            .selectFrom('employee as e')
            .innerJoin('user_account as u', 'u.id', 'e.user_id')
            .select((eb) => eb.fn.count<string>('u.id').distinct().as('n'))
            .where('e.company_id', '=', companyId)
            .where('e.status', '=', 'active')
            .where('u.last_login_at', 'is', null)
            .executeTakeFirstOrThrow()
        ).n,
      );
      const devices = Number(
        (
          await db
            .selectFrom('kiosk_device')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('hotel_id', 'in', hs)
            .where('status', '=', 'active')
            .executeTakeFirstOrThrow()
        ).n,
      );
      const rulesViewed = await db
        .selectFrom('audit_log')
        .select('id')
        .where('action', '=', 'rules_viewed')
        .where('company_id', '=', companyId)
        .limit(1)
        .executeTakeFirst();
      const published = await db
        .selectFrom('schedule_snapshot')
        .select('id')
        .where('hotel_id', 'in', hs)
        .limit(1)
        .executeTakeFirst();
      return {
        companyId,
        hotelsDepartments: { done: hotelIds.length > 0 && depts > 0, count: depts },
        employees: { done: emps > 0, count: emps },
        invitations: { done: emps > 0 && neverIn === 0, count: neverIn },
        tablet: { done: devices > 0, count: devices },
        rules: { done: !!rulesViewed },
        firstPublish: { done: !!published },
      };
    },
  );

  r.post(
    '/setup/rules-viewed',
    {
      preValidation: requireRole(AD, SA),
      schema: { body: z.object({ companyId: z.number().int().optional() }).optional() },
    },
    async (req, reply) => {
      const companyId = await companyOf(req, req.body?.companyId);
      await db.transaction().execute((trx) =>
        audit(trx, actorOf(req), {
          action: 'rules_viewed',
          entityType: 'company',
          entityId: companyId,
          companyId,
        }),
      );
      return reply.status(204).send();
    },
  );

  // ---- admin overview (KPIs, action needed, recent changes) ----------------------------------
  r.get(
    '/setup/overview',
    {
      preValidation: requireRole(AD, SA),
      schema: { querystring: z.object({ companyId: z.coerce.number().int().optional() }) },
    },
    async (req) => {
      const companyId = await companyOf(req, req.query.companyId);
      const hotelIds = (
        await db.selectFrom('hotel').select('id').where('company_id', '=', companyId).execute()
      ).map((h) => h.id);
      const hs = hotelIds.length ? hotelIds : [0];
      const cnt = async (q: any) => Number((await q.executeTakeFirstOrThrow()).n);
      const employees = await cnt(
        db
          .selectFrom('employee')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('company_id', '=', companyId)
          .where('status', '=', 'active'),
      );
      const activeUsers = await cnt(
        db
          .selectFrom('employee as e')
          .innerJoin('user_account as u', 'u.id', 'e.user_id')
          .select((eb) => eb.fn.count<string>('u.id').distinct().as('n'))
          .where('e.company_id', '=', companyId)
          .where('u.status', '=', 'active'),
      );
      const devices = await db
        .selectFrom('kiosk_device')
        .select(['status', 'last_seen_at'])
        .where('hotel_id', 'in', hs)
        .execute();
      const now = app.clock().getTime();
      const online = devices.filter(
        (d) => d.status === 'active' && d.last_seen_at && now - new Date(d.last_seen_at).getTime() < 3 * 60e3,
      ).length;
      const pendingTimeOff = await cnt(
        db
          .selectFrom('time_off as t')
          .innerJoin('employee as e', 'e.employee_id', 't.employee_id')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('e.company_id', '=', companyId)
          .where('t.status', '=', 'pending'),
      );
      const pendingCorr = await cnt(
        db
          .selectFrom('time_correction_request')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('hotel_id', 'in', hs)
          .where('status', '=', 'pending'),
      );
      const pendingPunch = await cnt(
        db
          .selectFrom('punch_record')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('hotel_id', 'in', hs)
          .where('approval_status', '=', 'pending')
          .where('actual_punch_out', 'is not', null),
      );
      const neverIn = await cnt(
        db
          .selectFrom('employee as e')
          .innerJoin('user_account as u', 'u.id', 'e.user_id')
          .select((eb) => eb.fn.count<string>('u.id').distinct().as('n'))
          .where('e.company_id', '=', companyId)
          .where('e.status', '=', 'active')
          .where('u.last_login_at', 'is', null),
      );
      const openRequests = pendingTimeOff + pendingCorr + pendingPunch;
      const actionNeeded: Array<{ kind: string; count: number }> = [];
      if (openRequests) actionNeeded.push({ kind: 'open_requests', count: openRequests });
      if (neverIn) actionNeeded.push({ kind: 'never_signed_in', count: neverIn });
      const offline = devices.filter((d) => d.status === 'active').length - online;
      if (offline > 0) actionNeeded.push({ kind: 'tablets_offline', count: offline });
      const audits = await db
        .selectFrom('audit_log')
        .select(['id', 'created_at', 'actor_id', 'action', 'entity_type', 'entity_id'])
        .where((eb) => eb.or([eb('company_id', '=', companyId), eb('hotel_id', 'in', hs)]))
        .where('action', 'not in', [
          'login',
          'login_failed',
          'logout',
          'select_role',
          'switch_role',
          'rules_viewed',
        ])
        .orderBy('id', 'desc')
        .limit(8)
        .execute();
      const recentChanges = [];
      for (const a of audits) {
        let name: string | null = null;
        if (a.actor_id) name = (await loadAvailableRoles(db, a.actor_id)).name || null;
        recentChanges.push({
          id: a.id,
          at: a.created_at,
          actor: name,
          action: a.action,
          entityType: a.entity_type,
          entityId: a.entity_id,
        });
      }
      return {
        companyId,
        kpis: {
          employees,
          activeUsers,
          tabletsOnline: online,
          tabletsTotal: devices.filter((d) => d.status === 'active').length,
          openRequests,
        },
        actionNeeded,
        recentChanges,
      };
    },
  );
}
