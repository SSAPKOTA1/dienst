import pg from 'pg';
import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import type { DB } from './types';

// DATE -> 'YYYY-MM-DD' string (never a JS Date in local time), NUMERIC -> number.
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(1700, (v: string) => parseFloat(v));

export type Db = Kysely<DB>;
export type Trx = Transaction<DB>;
export type DbOrTrx = Db | Trx;

export function createDb(connectionString: string): Db {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) }) });
}

export type { DB };
