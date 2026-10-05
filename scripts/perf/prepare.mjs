// Adds login accounts to the synthetic perf database (scripts/perf/seed.sql): a manager of three hotels and an employee.
// Usage: DATABASE_URL=postgres://.../dienst_perf node scripts/perf/prepare.mjs
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const argon2 = require('argon2');
const pg = require('pg');
const url = process.env.DATABASE_URL ?? 'postgres://dienst:dienst@localhost:5432/dienst_perf';
const PASSWORD = 'Perf!Test-12345';
const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  await c.query('begin');
  await c.query(
    `delete from manager_hotel where manager_id in (select manager_id from manager where first_name = 'Perf')`,
  );
  await c.query(`delete from manager where first_name = 'Perf'`);
  await c.query(
    `delete from refresh_token where user_id in (select id from user_account where email in ('perf-mgr@x.test', 'e1@perf.test'))`,
  );
  await c.query(`delete from kiosk_device where name = 'perf tablet'`);
  await c.query(`delete from user_account where email = 'perf-mgr@x.test'`);
  const u = await c.query(
    `insert into user_account (email, password_hash, status) values ('perf-mgr@x.test', $1, 'active') returning id`,
    [hash],
  );
  const m = await c.query(
    `insert into manager (user_id, first_name, last_name) values ($1, 'Perf', 'Manager') returning manager_id`,
    [u.rows[0].id],
  );
  // hotels 1, 4, 7 belong to the same company (company = 1 + hotel % 3)
  for (const h of [1, 4, 7])
    await c.query(`insert into manager_hotel (manager_id, hotel_id) values ($1, $2)`, [
      m.rows[0].manager_id,
      h,
    ]);
  await c.query(`update user_account set password_hash = $1 where email = 'e1@perf.test'`, [hash]);
  // today's roster of hotel 1: every one of its employees is planned today (the synthetic history ends in September)
  await c.query(`delete from schedule where shift_date = current_date and hotel_id = 1`);
  await c.query(`
    insert into schedule (hotel_id, employee_id, shift_id, shift_date, planned_start, planned_end, planned_break_minutes, status, created_by_user_id, created_by_role)
    select e.primary_hotel_id, e.employee_id, (select min(id) from shift where hotel_id = e.primary_hotel_id), current_date,
           (current_date + time '04:00') at time zone 'UTC', (current_date + time '12:00') at time zone 'UTC', 30, 'published', 1, 'admin'
    from employee e where e.primary_hotel_id = 1`);
  // a tablet for hotel 1 (the runner sends this token)
  const crypto = await import('node:crypto');
  await c.query(`delete from kiosk_device where name = 'perf tablet'`);
  await c.query(
    `insert into kiosk_device (hotel_id, name, token_hash, registered_by_user_id) values (1, 'perf tablet', $1, $2)`,
    [crypto.createHash('sha256').update('kd_perf_tablet_token').digest('hex'), u.rows[0].id],
  );
  await c.query('commit');
  console.log(
    'perf accounts ready: perf-mgr@x.test (manager of hotels 1, 4, 7) and e1@perf.test (employee), password',
    PASSWORD,
  );
} finally {
  await c.end();
}
