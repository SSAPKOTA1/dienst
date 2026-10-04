import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { loadConfig, type Config } from './config';
import { createDb, type Db } from './db';
import rateLimit from '@fastify/rate-limit';
import { AppError } from './lib/errors';
import { Mailer } from './lib/mail';
import { authRoutes } from './routes/auth';
import { meRoutes } from './routes/me';
import { organisationRoutes } from './routes/organisation';
import { employeeRoutes } from './routes/employees';
import { setupRoutes } from './routes/setup';
import { shiftRoutes } from './routes/shifts';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    cfg: Config;
    clock: () => Date;
    mailer: Mailer;
  }
}

export interface AppOptions {
  config?: Partial<Record<keyof Config, unknown>>;
  clock?: () => Date;
  logger?: boolean | object;
  db?: Db;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const cfg = loadConfig({ ...process.env, ...(opts.config as NodeJS.ProcessEnv | undefined) });
  const app = Fastify({
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
    trustProxy: true,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('cfg', cfg);
  app.decorate('clock', opts.clock ?? (() => new Date()));
  const db = opts.db ?? createDb(cfg.DATABASE_URL);
  app.decorate('db', db);
  app.addHook('onClose', async () => {
    if (!opts.db) await db.destroy();
  });

  app.decorateRequest('principal', null);
  app.decorateRequest('preUserId', null);
  app.decorate(
    'mailer',
    new Mailer(
      { mode: cfg.MAIL_MODE, host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, from: cfg.MAIL_FROM },
      app.log,
    ),
  );

  await app.register(helmet);
  await app.register(rateLimit, { global: false });
  await app.register(cookie);
  await app.register(cors, { origin: cfg.WEB_ORIGIN, credentials: true });

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
      await api.register(meRoutes);
      await api.register(organisationRoutes);
      await api.register(employeeRoutes);
      await api.register(setupRoutes);
      await api.register(shiftRoutes);
      api.get('/health', async () => {
        await sql`select 1`.execute(db);
        return { status: 'ok', time: app.clock().toISOString() };
      });
    },
    { prefix: '/api/v1' },
  );
  void r;
  return app;
}
