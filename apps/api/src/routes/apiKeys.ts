import type { DB } from '../db';
import type { Selectable } from 'kysely';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { addDays } from '@dienst/rules';
import { AppError } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { randomToken, sha256 } from '../lib/security';
import { idParam, isoDate } from '../lib/http';
import { cidrList, ipInCidrs } from '../lib/net';
import type { Trx } from '../db';

const KEY_PREFIX = 'dk_';

/** What a key may read. A key is created with the smallest set its user needs. */
export const API_SCOPES = [
  'hotels:read',
  'employees:read',
  'schedule:read',
  'attendance:read',
  'absences:read',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];
const MAX_VALID_DAYS = 730;
const DEFAULT_VALID_DAYS = 365;
const ADMIN = requireRole('superAdmin', 'admin');

declare module 'fastify' {
  interface FastifyRequest {
    apiKey: { id: number; companyId: number; hotelIds: number[]; scopes: string[] } | null;
  }
}

/** Key management for administrators. The key itself is shown once; only its hash is stored. */
export async function apiKeyRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);
  const out = (k: Selectable<DB['api_key']>) => ({
    id: k.id,
    companyId: k.company_id,
    hotelId: k.hotel_id,
    name: k.name,
    prefix: k.key_prefix,
    lastUsedAt: k.last_used_at?.toISOString() ?? null,
    revokedAt: k.revoked_at?.toISOString() ?? null,
    expiresAt: k.expires_at?.toISOString() ?? null,
    scopes: k.scopes,
    allowedCidrs: k.allowed_cidrs ?? [],
    lastUsedIp: k.last_used_ip ?? null,
    createdAt: k.created_at?.toISOString() ?? null,
  });

  r.get('/api-keys', { preValidation: ADMIN }, async (req) => {
    const p = getPrincipal(req);
    const rows = await db
      .selectFrom('api_key')
      .selectAll()
      .where('company_id', 'in', p.scope.companyIds.length ? p.scope.companyIds : [0])
      .orderBy('id', 'desc')
      .execute();
    return { items: rows.map(out) };
  });

  r.post(
    '/api-keys',
    {
      preValidation: ADMIN,
      schema: {
        body: z.object({
          companyId: z.number().int().positive(),
          hotelId: z.number().int().positive().nullish(),
          name: z.string().min(1).max(100),
          scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
          expiresInDays: z.number().int().min(1).max(MAX_VALID_DAYS).default(DEFAULT_VALID_DAYS),
          allowedCidrs: cidrList.optional(),
        }),
      },
    },
    async (req, reply) => {
      const p = getPrincipal(req);
      const b = req.body;
      p.scope.assertCompany(b.companyId);
      if (b.hotelId) {
        p.scope.assertHotel(b.hotelId);
        const h = await db
          .selectFrom('hotel')
          .select('company_id')
          .where('id', '=', b.hotelId)
          .executeTakeFirst();
        if (!h || h.company_id !== b.companyId)
          throw new AppError('VALIDATION', 'The hotel is not part of this company');
      }
      const secret = KEY_PREFIX + randomToken();
      const row = await tx(async (trx) => {
        const row = await trx
          .insertInto('api_key')
          .values({
            company_id: b.companyId,
            hotel_id: b.hotelId ?? null,
            name: b.name.trim(),
            key_prefix: secret.slice(0, 10),
            key_hash: sha256(secret),
            created_by_user_id: p.userId,
            scopes: [...new Set(b.scopes)],
            expires_at: new Date(app.clock().getTime() + b.expiresInDays * 86400e3),
            allowed_cidrs: b.allowedCidrs?.length ? b.allowedCidrs : null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx, actorOf(req), {
          action: 'api_key_created',
          entityType: 'api_key',
          entityId: row.id,
          companyId: b.companyId,
          hotelId: b.hotelId ?? undefined,
          new: {
            name: row.name,
            scopes: row.scopes,
            expiresAt: row.expires_at,
            allowedCidrs: row.allowed_cidrs,
          },
        });
        return row;
      });
      return reply.status(201).send({ ...out(row), key: secret });
    },
  );

  r.delete('/api-keys/:id', { preValidation: ADMIN, schema: { params: idParam } }, async (req, reply) => {
    const p = getPrincipal(req);
    await tx(async (trx) => {
      const k = await trx
        .selectFrom('api_key')
        .selectAll()
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!k) throw new AppError('NOT_FOUND', 'API key not found');
      p.scope.assertCompany(k.company_id);
      if (k.revoked_at) return;
      await trx.updateTable('api_key').set({ revoked_at: app.clock() }).where('id', '=', k.id).execute();
      await audit(trx, actorOf(req), {
        action: 'api_key_revoked',
        entityType: 'api_key',
        entityId: k.id,
        companyId: k.company_id,
        new: { name: k.name },
      });
    });
    return reply.status(204).send();
  });
}

// ------------------------------------------------------------------------------------------------
// Public read-only API. Auth: `Authorization: Bearer dk_...` or `X-API-Key`. GET only.

const page = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const window = page.extend({ from: isoDate, to: isoDate });

export async function publicApiRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  app.decorateRequest('apiKey', null);

  async function keyAuth(req: FastifyRequest) {
    const h = req.headers.authorization;
    const raw =
      (h?.startsWith('Bearer ') ? h.slice(7) : null) ?? (req.headers['x-api-key'] as string | undefined);
    if (!raw || !raw.startsWith(KEY_PREFIX))
      throw new AppError('UNAUTHENTICATED', 'Missing or invalid API key');
    const k = await db
      .selectFrom('api_key')
      .selectAll()
      .where('key_hash', '=', sha256(raw))
      .executeTakeFirst();
    if (!k || k.revoked_at) throw new AppError('UNAUTHENTICATED', 'Missing or invalid API key');
    const now = app.clock();
    if (k.expires_at <= now) throw new AppError('UNAUTHENTICATED', 'The API key has expired');
    if (k.allowed_cidrs?.length && !ipInCidrs(req.ip, k.allowed_cidrs))
      throw new AppError('FORBIDDEN_SCOPE', 'This API key may not be used from this address');
    const hotels = await db
      .selectFrom('hotel')
      .select('id')
      .where('company_id', '=', k.company_id)
      .$if(k.hotel_id != null, (q) => q.where('id', '=', k.hotel_id!))
      .execute();
    req.apiKey = { id: k.id, companyId: k.company_id, hotelIds: hotels.map((x) => x.id), scopes: k.scopes };
    if (!k.last_used_at || now.getTime() - k.last_used_at.getTime() > 60e3)
      await db
        .updateTable('api_key')
        .set({ last_used_at: now, last_used_ip: req.ip.slice(0, 45) })
        .where('id', '=', k.id)
        .execute();
  }
  const limit = {
    rateLimit: {
      max: 120,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) =>
        String(req.headers['x-api-key'] ?? req.headers.authorization ?? req.ip),
    },
  };
  /** Authenticated key that must hold `scope`. */
  const scoped = (scope: ApiScope) => ({
    preValidation: [
      keyAuth,
      async (req: FastifyRequest) => {
        if (!req.apiKey!.scopes.includes(scope))
          throw new AppError('FORBIDDEN_SCOPE', 'This API key may not read this data', {
            requiredScope: scope,
          });
      },
    ],
    config: limit,
  });
  const days = (from: string, to: string) => {
    if (to < from || addDays(from, 366) < to)
      throw new AppError('VALIDATION', 'The range is at most 366 days');
  };
  const hotelFilter = (req: FastifyRequest, hotelId?: number) => {
    const ids = req.apiKey!.hotelIds;
    if (hotelId && !ids.includes(hotelId)) throw new AppError('FORBIDDEN_SCOPE', 'Hotel is outside this key');
    return hotelId ? [hotelId] : ids.length ? ids : [0];
  };
  const hotelQ = z.object({ hotelId: z.coerce.number().int().positive().optional() });

  r.get('/hotels', scoped('hotels:read'), async (req) => {
    const rows = await db
      .selectFrom('hotel')
      .select(['id', 'name', 'city', 'timezone'])
      .where('id', 'in', req.apiKey!.hotelIds.length ? req.apiKey!.hotelIds : [0])
      .orderBy('id')
      .execute();
    return { items: rows.map((h) => ({ id: h.id, name: h.name, city: h.city, timezone: h.timezone })) };
  });

  r.get(
    '/employees',
    { ...scoped('employees:read'), schema: { querystring: page.merge(hotelQ) } },
    async (req) => {
      const hotels = hotelFilter(req, req.query.hotelId);
      const rows = await db
        .selectFrom('employee as e')
        .innerJoin('department as d', 'd.id', 'e.primary_department_id')
        .select([
          'e.employee_id',
          'e.personnel_number',
          'e.first_name',
          'e.last_name',
          'e.status',
          'e.primary_hotel_id',
          'd.name as department',
        ])
        .where('e.company_id', '=', req.apiKey!.companyId)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('employee_hotel as eh')
              .select('eh.employee_id')
              .whereRef('eh.employee_id', '=', 'e.employee_id')
              .where('eh.hotel_id', 'in', hotels),
          ),
        )
        .orderBy('e.employee_id')
        .limit(req.query.limit)
        .offset(req.query.offset)
        .execute();
      return {
        items: rows.map((e) => ({
          id: e.employee_id,
          personnelNumber: e.personnel_number,
          firstName: e.first_name,
          lastName: e.last_name,
          status: e.status,
          primaryHotelId: e.primary_hotel_id,
          department: e.department,
        })),
      };
    },
  );

  r.get(
    '/schedule',
    { ...scoped('schedule:read'), schema: { querystring: window.merge(hotelQ) } },
    async (req) => {
      days(req.query.from, req.query.to);
      const rows = await db
        .selectFrom('schedule as s')
        .innerJoin('employee as e', 'e.employee_id', 's.employee_id')
        .leftJoin('shift as sh', 'sh.id', 's.shift_id')
        .select([
          's.id',
          's.hotel_id',
          's.employee_id',
          'e.personnel_number',
          's.shift_date',
          's.planned_start',
          's.planned_end',
          's.planned_break_minutes',
          'sh.name as shift',
        ])
        .where('s.hotel_id', 'in', hotelFilter(req, req.query.hotelId))
        .where('s.status', '=', 'published')
        .where('s.shift_date', '>=', req.query.from)
        .where('s.shift_date', '<=', req.query.to)
        .orderBy('s.planned_start')
        .orderBy('s.id')
        .limit(req.query.limit)
        .offset(req.query.offset)
        .execute();
      return {
        items: rows.map((s) => ({
          id: s.id,
          hotelId: s.hotel_id,
          employeeId: s.employee_id,
          personnelNumber: s.personnel_number,
          date: s.shift_date as unknown as string,
          start: s.planned_start.toISOString(),
          end: s.planned_end.toISOString(),
          breakMinutes: s.planned_break_minutes,
          shift: s.shift,
        })),
      };
    },
  );

  r.get(
    '/attendance',
    { ...scoped('attendance:read'), schema: { querystring: window.merge(hotelQ) } },
    async (req) => {
      days(req.query.from, req.query.to);
      const rows = await db
        .selectFrom('punch_record as p')
        .innerJoin('employee as e', 'e.employee_id', 'p.employee_id')
        .select([
          'p.id',
          'p.hotel_id',
          'p.employee_id',
          'e.personnel_number',
          'p.shift_date',
          'p.paid_start',
          'p.paid_end',
          'p.actual_break_minutes',
          'p.paid_hours',
          'p.source',
        ])
        .where('p.hotel_id', 'in', hotelFilter(req, req.query.hotelId))
        .where('p.approval_status', '=', 'approved') // only approved hours leave the system
        .where('p.actual_punch_out', 'is not', null)
        .where('p.shift_date', '>=', req.query.from)
        .where('p.shift_date', '<=', req.query.to)
        .orderBy('p.shift_date')
        .orderBy('p.id')
        .limit(req.query.limit)
        .offset(req.query.offset)
        .execute();
      return {
        items: rows.map((x) => ({
          id: x.id,
          hotelId: x.hotel_id,
          employeeId: x.employee_id,
          personnelNumber: x.personnel_number,
          date: x.shift_date as unknown as string,
          start: x.paid_start?.toISOString() ?? null,
          end: x.paid_end?.toISOString() ?? null,
          breakMinutes: x.actual_break_minutes,
          paidHours: x.paid_hours == null ? null : Number(x.paid_hours),
          source: x.source,
        })),
      };
    },
  );

  r.get(
    '/absences',
    { ...scoped('absences:read'), schema: { querystring: window.merge(hotelQ) } },
    async (req) => {
      days(req.query.from, req.query.to);
      const hotels = hotelFilter(req, req.query.hotelId);
      const rows = await db
        .selectFrom('time_off as t')
        .innerJoin('employee as e', 'e.employee_id', 't.employee_id')
        .select([
          't.id',
          't.employee_id',
          'e.personnel_number',
          't.start_date',
          't.end_date',
          't.half_day',
          't.time_off_days',
          't.type',
        ])
        .where('e.company_id', '=', req.apiKey!.companyId)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('employee_hotel as eh')
              .select('eh.employee_id')
              .whereRef('eh.employee_id', '=', 'e.employee_id')
              .where('eh.hotel_id', 'in', hotels),
          ),
        )
        .where('t.status', '=', 'approved')
        .where('t.start_date', '<=', req.query.to)
        .where('t.end_date', '>=', req.query.from)
        .orderBy('t.start_date')
        .orderBy('t.id')
        .limit(req.query.limit)
        .offset(req.query.offset)
        .execute();
      return {
        items: rows.map((a) => ({
          id: a.id,
          employeeId: a.employee_id,
          personnelNumber: a.personnel_number,
          from: a.start_date as unknown as string,
          to: a.end_date as unknown as string,
          halfDay: a.half_day,
          days: Number(a.time_off_days),
          // health-related and protected absences are never exposed: everything but vacation is just "absence"
          type: a.type === 'annual_leave' ? 'vacation' : 'absence',
        })),
      };
    },
  );

  r.get('/openapi.json', { config: { rateLimit: false } }, async () => openApiDocument());
}

function openApiDocument() {
  const pageParams = [
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
    { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
  ];
  const windowParams = [
    { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
    { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
    { name: 'hotelId', in: 'query', schema: { type: 'integer' } },
    ...pageParams,
  ];
  const list = (summary: string, parameters: unknown[]) => ({
    get: {
      summary,
      security: [{ apiKey: [] }],
      parameters,
      responses: {
        '200': { description: 'A page of items: { items: [...] }' },
        '401': { description: 'Missing, revoked or expired key' },
        '403': { description: 'Hotel outside this key, scope missing, or address not allowed' },
        '429': { description: 'Rate limit: 120 requests per minute and key' },
      },
    },
  });
  return {
    openapi: '3.0.3',
    info: {
      title: 'Dienstplan public API',
      version: '1.0.0',
      description:
        'Read-only. Keys are created by administrators, expire (at most 2 years), are bound to a company and optionally one hotel, carry scopes (hotels:read, employees:read, schedule:read, attendance:read, absences:read) and can be limited to network ranges. Only published shifts and approved hours are returned. No wages, no health data.',
    },
    servers: [{ url: '/api/public/v1' }],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'Also accepted as `Authorization: Bearer <key>`.',
        },
      },
    },
    paths: {
      '/hotels': list('Hotels of the key', []),
      '/employees': list('Employees (personnel number, name, department, status)', [
        { name: 'hotelId', in: 'query', schema: { type: 'integer' } },
        ...pageParams,
      ]),
      '/schedule': list('Published shifts in a date range (max 366 days)', windowParams),
      '/attendance': list('Approved worked time in a date range (max 366 days)', windowParams),
      '/absences': list(
        'Approved absences; only vacation is named, everything else is "absence"',
        windowParams,
      ),
    },
  };
}
