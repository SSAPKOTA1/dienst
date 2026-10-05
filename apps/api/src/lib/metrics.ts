import client from 'prom-client';

/**
 * Prometheus metrics. One registry per process; counters that routes and jobs increment live here so
 * they do not need the app instance. Labels stay low-cardinality (route patterns, outcomes, job names).
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration by route pattern and status class',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const loginFailures = new client.Counter({
  name: 'login_failures_total',
  help: 'Failed logins (wrong credentials, locked accounts, bad second factor)',
  registers: [registry],
});

export const punches = new client.Counter({
  name: 'punches_total',
  help: 'Time clock actions by source and outcome',
  labelNames: ['source', 'action', 'outcome'] as const,
  registers: [registry],
});

export const jobRuns = new client.Counter({
  name: 'job_runs_total',
  help: 'Background job runs by outcome',
  labelNames: ['job', 'outcome'] as const,
  registers: [registry],
});

export const jobLastSuccess = new client.Gauge({
  name: 'job_last_success_timestamp_seconds',
  help: 'Unix time of the last successful run of a background job',
  labelNames: ['job'] as const,
  registers: [registry],
});

export const serverErrors = new client.Counter({
  name: 'server_errors_total',
  help: 'Unhandled errors answered with 5xx',
  registers: [registry],
});

export const dbPool = {
  total: new client.Gauge({
    name: 'db_pool_connections',
    help: 'Open database connections',
    registers: [registry],
  }),
  idle: new client.Gauge({
    name: 'db_pool_idle_connections',
    help: 'Idle database connections',
    registers: [registry],
  }),
  waiting: new client.Gauge({
    name: 'db_pool_waiting_requests',
    help: 'Requests waiting for a connection',
    registers: [registry],
  }),
};

/** Runs a background job and records its outcome and last success time. Errors are rethrown. */
export async function trackJob<T>(job: string, fn: () => Promise<T>): Promise<T> {
  try {
    const r = await fn();
    jobRuns.inc({ job, outcome: 'ok' });
    jobLastSuccess.set({ job }, Date.now() / 1000);
    return r;
  } catch (e) {
    jobRuns.inc({ job, outcome: 'error' });
    throw e;
  }
}
