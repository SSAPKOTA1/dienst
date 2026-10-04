import pg from 'pg';
import { migrate } from '../src/db/migrate';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://dienst:dienst@localhost:5432/dienst_test';
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(url, () => {});
  process.env.DATABASE_URL = url;
}
