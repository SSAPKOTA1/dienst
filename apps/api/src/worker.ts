import pino from 'pino';
import { loadConfig } from './config';
import { createDb } from './db';
import { startJobs } from './jobs/scheduler';

/** Background jobs only (no HTTP). Run one of these next to API processes started with RUN_JOBS=false. */
const cfg = loadConfig();
const log = pino({ level: cfg.LOG_LEVEL, base: { app: 'dienst-worker' } });
const db = createDb(cfg.DATABASE_URL, { max: 3 });
const stop = startJobs(db, () => new Date(), log);
log.info('worker started');

async function shutdown(signal: string) {
  log.info({ signal }, 'worker stopping');
  stop();
  await db.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
