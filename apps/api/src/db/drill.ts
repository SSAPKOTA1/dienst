import { sql } from 'kysely';
import { createDb } from './index';
import { migrationFiles } from './migrate';
import { verifyAuditChains } from '../lib/audit';

/**
 * Checks a restored database: the essential tables hold data, every migration is recorded, and the audit hash
 * chains recompute. Exits 1 with the reasons if anything is wrong. Used by scripts/ops/restore-drill.sh.
 */
const db = createDb(process.env.DATABASE_URL ?? '', { max: 2 });
const problems: string[] = [];
try {
  const done = new Set((await sql<{ name: string }>`select name from schema_migrations`.execute(db)).rows.map((r) => r.name));
  for (const f of migrationFiles()) if (!done.has(f)) problems.push(`migration not recorded: ${f}`);
  for (const t of ['company', 'hotel', 'employee', 'user_account'] as const) {
    const n = (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(t)}`.execute(db)).rows[0].n;
    console.log(`${t.padEnd(14)} ${n} rows`);
    if (n === 0) problems.push(`${t} is empty`);
  }
  const chains = await verifyAuditChains(db);
  console.log(`audit chains   ${chains.chains.length} checked, ${chains.chains.filter((c) => !c.ok).length} broken, ${chains.legacyRows} legacy rows`);
  for (const c of chains.chains) if (!c.ok) problems.push(`audit chain ${c.chainKey} broken at entry ${c.brokenAt}`);
} catch (e) {
  problems.push((e as Error).message);
} finally {
  await db.destroy();
}
if (problems.length) {
  console.error('DRILL FAILED:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log('data checks passed');
