import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, migrationFiles, rollback } from '../src/db/migrate';

const base = process.env.DATABASE_URL ?? 'postgres://dienst:dienst@localhost:5432/dienst';
const url = (db: string) => base.replace(/\/[^/]*$/, `/${db}`);
const admin = new pg.Pool({ connectionString: url('postgres'), max: 2 });
const names = ['dienst_mig_a', 'dienst_mig_b'];

async function fresh(db: string) {
  await admin.query(`drop database if exists ${db}`);
  await admin.query(`create database ${db}`);
}

/** Everything that defines the schema, as sorted text lines. */
async function shape(db: string): Promise<string[]> {
  const c = new pg.Client({ connectionString: url(db) });
  await c.connect();
  try {
    const cols = await c.query(
      `select 'col ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') as l
       from information_schema.columns where table_schema = 'public' and table_name <> 'schema_migrations'`,
    );
    const idx = await c.query(
      `select 'idx ' || indexdef as l from pg_indexes where schemaname = 'public' and tablename <> 'schema_migrations'`,
    );
    const con = await c.query(
      `select 'con ' || conrelid::regclass || ' ' || pg_get_constraintdef(oid) as l from pg_constraint where connamespace = 'public'::regnamespace`,
    );
    return [...cols.rows, ...idx.rows, ...con.rows].map((r) => r.l as string).sort();
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  for (const n of names) await fresh(n);
});
afterAll(async () => {
  for (const n of names) await admin.query(`drop database if exists ${n}`);
  await admin.end();
});

describe('migrations', () => {
  it('lists the migrations without the rollback files', () => {
    const files = migrationFiles();
    expect(files[0]).toBe('001_init.sql');
    expect(files.some((f) => f.endsWith('.down.sql'))).toBe(false);
  });

  it('two runners at once apply every migration exactly once', async () => {
    const [a, b] = await Promise.all([
      migrate(url(names[0]), () => undefined),
      migrate(url(names[0]), () => undefined),
    ]);
    expect(a.length + b.length).toBe(migrationFiles().length);
    expect(await migrate(url(names[0]), () => undefined)).toEqual([]);
  });

  it('rolls the newest migrations back and forward again to the same schema', async () => {
    await migrate(url(names[1]), () => undefined);
    const before = await shape(names[1]);
    // 001 to 004 cannot be rolled back; everything after them can
    const reversible = migrationFiles().length - 4;
    const undone = await rollback(url(names[1]), reversible, () => undefined);
    expect(undone[0]).toBe(migrationFiles().at(-1));
    expect(undone).toHaveLength(reversible);
    const reduced = await shape(names[1]);
    expect(reduced.length).toBeLessThan(before.length);
    expect(reduced.some((l) => l.includes('api_key') || l.includes('feed_post'))).toBe(false);
    await migrate(url(names[1]), () => undefined);
    expect(await shape(names[1])).toEqual(before);
    expect(await shape(names[1])).toEqual(await shape(names[0]));
  });

  it('refuses to roll back a migration that has no down file', async () => {
    await expect(rollback(url(names[0]), 20, () => undefined)).rejects.toThrow(/no \.down\.sql/);
    // the ones above it were undone before the refusal; bring the database back for the other tests
    await migrate(url(names[0]), () => undefined);
  });
});
