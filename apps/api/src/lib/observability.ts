import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { poolOf, type Db } from '../db';
import { dbPool, httpDuration, registry, serverErrors } from './metrics';
import { AppError } from './errors';

/** An id that is safe to log and echo: the caller's `X-Request-Id` if it looks harmless, else a new one. */
export function requestIdFrom(req: { headers: Record<string, string | string[] | undefined> }): string {
  const h = req.headers['x-request-id'];
  const v = Array.isArray(h) ? h[0] : h;
  return v && /^[A-Za-z0-9._-]{8,64}$/.test(v) ? v : randomUUID();
}

/** Reports a server error to the configured webhook, at most once per signature every 30 seconds. */
export function makeErrorReporter(url: string | undefined, log: { warn: (o: object, m: string) => void }) {
  const lastSent = new Map<string, number>();
  return async (err: Error, ctx: { requestId: string; method: string; route: string }) => {
    if (!url) return;
    const sig = `${err.name}:${err.message}`.slice(0, 200);
    const now = Date.now();
    if (now - (lastSent.get(sig) ?? 0) < 30_000) return;
    lastSent.set(sig, now);
    if (lastSent.size > 500) lastSent.clear();
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // no request bodies, headers or user data: only what is needed to find the error in the logs
        body: JSON.stringify({
          text: `dienst: ${err.name}: ${err.message}`,
          requestId: ctx.requestId,
          method: ctx.method,
          route: ctx.route,
          stack: err.stack?.split('\n').slice(0, 8),
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      log.warn({ requestId: ctx.requestId }, 'error webhook failed');
    }
  };
}

export interface Lifecycle {
  /** set when the process was told to stop: readiness then answers 503 so the balancer stops sending traffic */
  shuttingDown: boolean;
}

/** Request ids, request metrics, /metrics, liveness and readiness. */
export function registerObservability(
  app: FastifyInstance,
  cfg: Config,
  db: Db,
  life: Lifecycle,
  migrationsReady: () => Promise<boolean>,
) {
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unmatched'; // pattern, never the raw path (ids, tokens)
    httpDuration.observe(
      { method: req.method, route, status: `${Math.floor(reply.statusCode / 100)}xx` },
      reply.elapsedTime / 1000,
    );
  });

  const report = makeErrorReporter(cfg.ERROR_WEBHOOK_URL, app.log);
  app.addHook('onError', async (req: FastifyRequest, _reply, err) => {
    if (err instanceof AppError && err.statusCode < 500) return;
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) return;
    serverErrors.inc();
    await report(err, { requestId: req.id, method: req.method, route: req.routeOptions?.url ?? 'unmatched' });
  });

  app.get('/metrics', { config: { rateLimit: false } }, async (req, reply) => {
    const token = cfg.METRICS_TOKEN;
    if (cfg.NODE_ENV === 'production' && !token) return reply.status(404).send();
    if (token && req.headers.authorization !== `Bearer ${token}`) return reply.status(401).send();
    const pool = poolOf(db);
    if (pool) {
      dbPool.total.set(pool.totalCount);
      dbPool.idle.set(pool.idleCount);
      dbPool.waiting.set(pool.waitingCount);
    }
    return reply.header('content-type', registry.contentType).send(await registry.metrics());
  });

  // liveness: the process is up and the event loop answers. No database here: a database outage must not
  // make the orchestrator restart healthy API processes.
  app.get('/api/v1/health/live', { config: { rateLimit: false } }, async () => ({ status: 'live' }));

  // readiness: can this instance serve requests? Database reachable, migrations applied, not shutting down.
  app.get('/api/v1/health/ready', { config: { rateLimit: false } }, async (_req, reply) => {
    if (life.shuttingDown) return reply.status(503).send({ status: 'shutting_down' });
    try {
      if (!(await migrationsReady())) return reply.status(503).send({ status: 'migrations_pending' });
    } catch {
      return reply.status(503).send({ status: 'database_unreachable' });
    }
    return { status: 'ready' };
  });
}
