import pg from 'pg';
import { migrate } from '../src/db/migrate';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://dienst:dienst@localhost:5432/dienst_test';
  const c = new pg.Client({ connectionString: url });
  try {
    await c.connect();
  } catch (e) {
    if ((e as { code?: string }).code !== '3D000') throw e;
    // the test database does not exist yet (fresh docker volume): create it through the maintenance database
    const u = new URL(url);
    const name = u.pathname.slice(1);
    u.pathname = '/postgres';
    const admin = new pg.Client({ connectionString: u.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
    await admin.end();
    return setup();
  }
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(url, () => {});
  process.env.DATABASE_URL = url;
}
