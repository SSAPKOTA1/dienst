import { buildApp } from './app';
import { loadConfig } from './config';
import type { Lifecycle } from './lib/observability';

const cfg = loadConfig();
const life: Lifecycle = { shuttingDown: false };
const app = await buildApp({ autoCheckout: true, lifecycle: life });

/**
 * Stops cleanly on SIGTERM/SIGINT (deploys, scaling): readiness turns 503 first so the balancer stops sending
 * traffic, then in-flight requests finish, idle connections close and the database pool is released.
 * A hard timeout ends the process if something hangs.
 */
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  life.shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const hard = setTimeout(() => {
    app.log.error('shutdown timed out, exiting');
    process.exit(1);
  }, cfg.SHUTDOWN_TIMEOUT_MS);
  hard.unref();
  try {
    // give the balancer a moment to notice the readiness change before the listener closes
    await new Promise((r) => setTimeout(r, cfg.SHUTDOWN_DRAIN_MS));
    await app.close();
    process.exit(0);
  } catch (e) {
    app.log.error({ err: (e as Error).message }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (e) => app.log.error({ err: (e as Error)?.message }, 'unhandled rejection'));

try {
  await app.listen({ port: cfg.API_PORT, host: '0.0.0.0' });
} catch (e) {
  app.log.error(e);
  process.exit(1);
}
