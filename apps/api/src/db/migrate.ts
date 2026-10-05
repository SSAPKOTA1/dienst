import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Where the SQL files are: next to the sources in a checkout, or `MIGRATIONS_DIR` (the container image). */
export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? path.resolve(here, '../../../../db/migrations');
/** One migration runner at a time: two deploys starting together would otherwise race on the same files. */
const LOCK_ID = 7002;

export async function migrate(
  databaseUrl: string,
  log: (m: string) => void = console.log,
): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
        log(`applied ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
    if (!applied.length) log('database is up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
  return applied;
}

const upFiles = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();

/** Migration files that are present (empty when the folder is missing, e.g. an unusual deployment). */
export const migrationFiles = (): string[] => (existsSync(MIGRATIONS_DIR) ? upFiles() : []);

/**
 * Undoes the newest `steps` migrations with their `NNN_name.down.sql` files (a migration without one cannot be
 * undone). Data in dropped columns or tables is gone: restore a backup if the data matters.
 */
export async function rollback(databaseUrl: string, steps = 1, log: (m: string) => void = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const undone: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    const rows = (await client.query('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT $1', [steps])).rows as Array<{ name: string }>;
    for (const { name } of rows) {
      const down = path.join(MIGRATIONS_DIR, name.replace(/\.sql$/, '.down.sql'));
      if (!existsSync(down)) throw new Error(`${name} has no .down.sql: it cannot be rolled back`);
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(down, 'utf8'));
        await client.query('DELETE FROM schema_migrations WHERE name = $1', [name]);
        await client.query('COMMIT');
        undone.push(name);
        log(`rolled back ${name}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`rollback of ${name} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
  return undone;
}
