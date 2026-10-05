import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { requireRole } from './lib/auth';
import swagger from '@fastify/swagger';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { Keys } from './lib/keys';
import { migrationFiles } from './db/migrate';
import { registerObservability, requestIdFrom, type Lifecycle } from './lib/observability';
import { registerSecurityHeaders } from './lib/securityHeaders';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { loadConfig, type Config } from './config';
import { createDb, type Db } from './db';
import rateLimit from '@fastify/rate-limit';
import { AppError } from './lib/errors';
import { Mailer } from './lib/mail';
import { authRoutes } from './routes/auth';
import { webauthnRoutes } from './routes/webauthn';
import { meRoutes } from './routes/me';
import { organisationRoutes } from './routes/organisation';
import { departmentRoutes } from './routes/organisationDevices';
import { employeeRoutes } from './routes/employees';
import { setupRoutes } from './routes/setup';
import { shiftRoutes } from './routes/shifts';
import { scheduleRoutes } from './routes/schedule';
import { kioskRoutes } from './routes/kiosk';
import { liveRoutes } from './routes/live';
import { approvalRoutes } from './routes/approvals';
import { occupancyRoutes } from './routes/occupancy';
import { apiKeyRoutes, publicApiRoutes } from './routes/apiKeys';
import { ssoRoutes } from './routes/sso';
import { selfRoutes } from './routes/self';
import { webPunchRoutes } from './routes/webPunch';
import { exportRoutes } from './routes/exports';
import { importRoutes } from './routes/imports';
import { leaveRoutes } from './routes/leave';
import { hoursRoutes } from './routes/hours';
import { swapRoutes } from './routes/swaps';
import { openShiftRoutes } from './routes/openShifts';
import { peopleRoutes } from './routes/people';
import { commsRoutes } from './routes/comms';
import { privacyRoutes } from './routes/privacy';
import { feedRoutes } from './routes/feed';
import { startJobs } from './jobs/scheduler';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    cfg: Config;
    keys: Keys;
    clock: () => Date;
    mailer: Mailer;
  }
}

export interface AppOptions {
  config?: Partial<Record<keyof Config, unknown>>;
  clock?: () => Date;
  logger?: boolean | object;
  db?: Db;
  /** run the auto-checkout job every minute (the server enables it; tests call runAutoCheckout directly) */
  autoCheckout?: boolean;
  /** shared with the server so SIGTERM can flip readiness before the process stops */
  lifecycle?: Lifecycle;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const cfg = loadConfig({ ...process.env, ...(opts.config as NodeJS.ProcessEnv | undefined) });
  const app = Fastify({
    genReqId: (req) => requestIdFrom(req),
    requestIdHeader: false,
    forceCloseConnections: 'idle',
    // a hop count N means: the N nearest hops are our own proxies, the next address is the client. (Fastify's own
    // number option counts differently, so spell it out as a function: hop 0 is the TCP peer.)
    trustProxy:
      typeof cfg.TRUST_PROXY === 'number'
        ? (_a: string, hop: number) => hop < Number(cfg.TRUST_PROXY)
        : cfg.TRUST_PROXY,
    logger: opts.logger ?? {
      level: cfg.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-kiosk-token"]',
          '*.pin',
          '*.password',
          '*.token',
          '*.code',
          '*.totp',
        ],
        censor: '[redacted]',
      },
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('cfg', cfg);
  app.decorate('keys', new Keys(cfg));
  app.decorate('clock', opts.clock ?? (() => new Date()));
  const db = opts.db ?? createDb(cfg.DATABASE_URL, { max: cfg.DB_POOL_MAX });
  app.decorate('db', db);
  app.addHook('onClose', async () => {
    if (!opts.db) await db.destroy();
  });

  app.decorateRequest('principal', null);
  app.decorateRequest('preUserId', null);
  app.decorateRequest('preSsoMfa', false);
  app.decorate(
    'mailer',
    new Mailer(
      { mode: cfg.MAIL_MODE, host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, from: cfg.MAIL_FROM },
      app.log,
    ),
  );

  if (opts.autoCheckout) {
    const stop = startJobs(db, app.clock, app.log);
    app.addHook('onClose', async () => stop());
  }

  await registerSecurityHeaders(app, cfg.NODE_ENV === 'production');
  const life = opts.lifecycle ?? { shuttingDown: false };
  registerObservability(app, cfg, db, life, async () => {
    const done = new Set(
      (await sql<{ name: string }>`select name from schema_migrations`.execute(db)).rows.map((r) => r.name),
    );
    return migrationFiles().every((f) => done.has(f));
  });

  // a proxy header that nobody trusts is almost always a misconfiguration: the web punch network check and the
  // rate limits would then see the proxy instead of the client. Say so once.
  if (cfg.TRUST_PROXY === false) {
    let warned = false;
    app.addHook('onRequest', async (req) => {
      if (!warned && req.headers['x-forwarded-for']) {
        warned = true;
        req.log.warn(
          'X-Forwarded-For received but TRUST_PROXY is not set: client addresses will be the proxy address',
        );
      }
    });
  }
  // internal API description generated from the zod schemas of the routes (`GET /api/v1/openapi.json`, admins only)
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: { title: 'Dienst internal API', version: '1.0.0' },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(rateLimit, { global: true, max: cfg.RATE_LIMIT_GLOBAL, timeWindow: '1 minute' });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 } });
  // exactly the configured web origin; any other origin gets no CORS headers at all
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || origin === cfg.WEB_ORIGIN),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'x-kiosk-token'],
    maxAge: 600,
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply
        .status(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply
        .status(400)
        .send({ error: { code: 'VALIDATION', message: 'Invalid request', details: { issues: err.issues } } });
    }
    const e = err as {
      validation?: unknown;
      code?: string;
      statusCode?: number;
      message?: string;
      issues?: unknown;
    };
    if (e.validation || e.issues) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: 'Invalid request',
          details: { issues: e.validation ?? e.issues },
        },
      });
    }
    if (e.statusCode === 429) {
      return reply
        .status(429)
        .send({ error: { code: 'RATE_LIMITED', message: 'Too many requests', details: {} } });
    }
    if (e.code === '23P01') {
      return reply.status(422).send({
        error: {
          code: 'RULE_BLOCKED',
          message: 'Overlapping entry',
          details: {
            violations: [{ code: 'OVERLAP', severity: 'block', message: 'Overlapping entry', details: {} }],
          },
        },
      });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply
        .status(e.statusCode)
        .send({ error: { code: 'VALIDATION', message: e.message ?? 'Bad request', details: {} } });
    }
    req.log.error({ err: { message: e.message, code: e.code } }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal error', details: {} } });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', details: {} } }),
  );

  const r = app.withTypeProvider<ZodTypeProvider>();
  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(webauthnRoutes);
      await api.register(ssoRoutes);
      await api.register(meRoutes);
      await api.register(organisationRoutes);
      await api.register(departmentRoutes);
      await api.register(employeeRoutes);
      await api.register(setupRoutes);
      await api.register(shiftRoutes);
      await api.register(scheduleRoutes);
      await api.register(kioskRoutes);
      await api.register(liveRoutes);
      await api.register(approvalRoutes);
      await api.register(selfRoutes);
      await api.register(apiKeyRoutes);
      await api.register(occupancyRoutes);
      await api.register(webPunchRoutes);
      await api.register(exportRoutes);
      await api.register(importRoutes);
      await api.register(leaveRoutes);
      await api.register(hoursRoutes);
      await api.register(swapRoutes);
      await api.register(openShiftRoutes);
      await api.register(peopleRoutes);
      await api.register(commsRoutes);
      await api.register(privacyRoutes);
      await api.register(feedRoutes);
      api.get('/health', { config: { rateLimit: false } }, async () => {
        await sql`select 1`.execute(db);
        return { status: 'ok', time: app.clock().toISOString() };
      });
    },
    { prefix: '/api/v1' },
  );
  app.get(
    '/api/v1/openapi.json',
    { preValidation: requireRole('superAdmin', 'admin'), schema: { hide: true } },
    async () => app.swagger(),
  );
  await app.register(publicApiRoutes, { prefix: '/api/public/v1' });
  void r;
  return app;
}
