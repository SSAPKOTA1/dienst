const last = new Map<string, string>();

/** Runs `fn` at most once per UTC day, after 03:00 UTC (the jobs are idempotent, this only avoids pointless work). */
export async function runDailyOnce(label: string, now: Date, fn: (now: Date) => Promise<unknown>) {
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < 3 || last.get(label) === day) return;
  last.set(label, day);
  await fn(now);
}
