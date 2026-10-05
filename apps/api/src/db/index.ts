import pg from 'pg';
import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import type { DB } from './types';

// DATE -> 'YYYY-MM-DD' string (never a JS Date in local time), NUMERIC -> number.
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(1700, (v: string) => parseFloat(v));

export type Db = Kysely<DB>;
export type Trx = Transaction<DB>;
export type DbOrTrx = Db | Trx;

const pools = new WeakMap<object, pg.Pool>();

export function createDb(connectionString: string, opts: { max?: number } = {}): Db {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  pools.set(db, pool);
  return db;
}

/** The connection pool behind a database handle (for metrics); undefined for transactions. */
export const poolOf = (db: object): pg.Pool | undefined => pools.get(db);

export type { DB };
