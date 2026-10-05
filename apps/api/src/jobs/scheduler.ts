import { sql } from 'kysely';
import type { Db } from '../db';
import { trackJob } from '../lib/metrics';
import { runDailyOnce } from './daily';
import { expireSwaps, runAutoCheckout, wipeExpiredCredentials } from './autoCheckout';
import { runVacationJobs } from '../services/vacationJobs';
import { runOffboarding, runReminders } from '../services/reminders';

/** Advisory lock id of the job leader (migrations use 7002). */
const JOBS_LOCK = 7003;

interface Log {
  error: (o: object, msg: string) => void;
}

/** One tick: runs every background job once. */
export async function runJobsOnce(db: Db, clock: () => Date, log: Log): Promise<void> {
  const jobs: Array<[string, () => Promise<unknown>]> = [
    ['vacation', () => runDailyOnce('vacation', clock(), (n) => runVacationJobs(db, n))],
    ['reminders', () => runDailyOnce('reminders', clock(), (n) => runReminders(db, n))],
    ['offboarding', () => runDailyOnce('offboarding', clock(), (n) => runOffboarding(db, n))],
    ['auto_checkout', () => runAutoCheckout(db, clock())],
    ['credential_wipe', () => wipeExpiredCredentials(db, clock())],
    ['swap_expiry', () => expireSwaps(db, clock())],
  ];
  await Promise.allSettled(
    jobs.map(([job, run]) =>
      trackJob(job, run).catch((e) => log.error({ job, err: (e as Error).message }, 'background job failed')),
    ),
  );
}

/**
 * Starts the minute timer. With several processes only the one holding the advisory lock runs a tick, so jobs
 * never run twice at the same time; the others skip the tick and take over when the leader is gone.
 */
export function startJobs(db: Db, clock: () => Date, log: Log, everyMs = 60_000): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await db.connection().execute(async (conn) => {
        const got = await sql<{ ok: boolean }>`select pg_try_advisory_lock(${JOBS_LOCK}) as ok`.execute(conn);
        if (!got.rows[0]?.ok) return;
        try {
          await runJobsOnce(db, clock, log);
        } finally {
          await sql`select pg_advisory_unlock(${JOBS_LOCK})`.execute(conn);
        }
      });
    } catch (e) {
      log.error({ err: (e as Error).message }, 'job scheduler tick failed');
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  return () => clearInterval(timer);
}
