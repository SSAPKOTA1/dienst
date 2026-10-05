# Performance notes

## How the indexes were chosen
`scripts/perf/seed.sql` builds a synthetic database (3 companies, 30 hotels, 3000 employees, 750,000 shifts and punch records, 360,000 notifications, 18,000 absences, 180,000 audit entries). `scripts/perf/queries.sql` holds the common read paths of the app (home screen, approval inbox, reports, planning grid, audit log, sessions), and `scripts/perf/run.sh` prints `EXPLAIN ANALYZE` timings. Migration `011_indexes.sql` is what the measurements called for; partial indexes cover the "open work" queries (pending, unread, not revoked).

```
createdb dienst_perf
DATABASE_URL=postgres://.../dienst_perf pnpm db:migrate     # before 011 for a baseline
psql dienst_perf -f scripts/perf/seed.sql
scripts/perf/run.sh
```

## Result (execution time in ms, same machine, warm cache)
| Query | before | after |
|---|---:|---:|
| notifications of one user, newest first | 15.24 | 0.17 |
| unread notification count | 14.62 | 0.11 |
| absences of one employee in a year | 2.58 | 0.09 |
| pending absences in the approval inbox (3 hotels) | 2.06 | 0.69 |
| pending worked time in the approval inbox (2 hotels) | 47.45 | 5.88 |
| worked time of a hotel for a month (reports, exports) | 28.37 | 6.09 |
| schedule of one employee for a month (portal) | 2.14 | 0.18 |
| pending variations of a hotel | 22.20 | 0.05 |
| schedule grid of a hotel for a week (already indexed) | 2.36 | 0.84 |
| audit log of one entity | 0.09 | 0.10 |
| audit log of a company, newest first (admin screen) | 27.06 | 0.12 |
| last entry of an audit chain (every audited write) | 15.74 | 0.03 |
| open refresh tokens of a user | 2.58 | 0.10 |
| active employees of a company, by name | 1.28 | 0.60 |
| employees of a hotel | 1.66 | 1.01 |
| primary-hotel employees (planning grid rows) | 0.61 | 0.28 |
| worked time of one employee for a month (indexed) | 0.31 | 0.19 |

Reading the table: the biggest gains are the ones that scanned a whole table to find a few rows (notifications, pending variations, the audit log of a company, the approval inbox). Queries that were already indexed (planning grid, one employee's month) are unchanged within noise.

## Audit log
Every audited write used to take one global advisory lock and read the newest entry of one global hash chain, so all writing requests of all companies queued behind each other until commit. Entries are now chained per company (companies without an id use 16 sub-chains by actor), so only writes of the same company wait for each other (measured by test: another company is not held up while one company's transaction is open). The chain can now be verified (`GET /audit-log/verify`), and audited writes outside a transaction get their own so they cannot fork a chain (found and fixed while testing).

## Load test and what it found
`scripts/perf/load.mjs` (autocannon) runs eight scenarios against the synthetic database (`seed.sql`: 3,000 employees, 750,000 schedule entries and punch records; `prepare.mjs` adds a manager, an employee, a tablet and a day of plan) and fails when a p97.5 latency budget or the error budget is exceeded. Run it: see the header of the script. CI runs it weekly and on demand (`.github/workflows/perf.yml`) with budgets multiplied by 3.

Measured on a 4-core sandbox VM, API and database on the same host, 20 connections (5 for the two heavy endpoints):

| Scenario | Before | After |
| --- | --- | --- |
| Week grid of one hotel (100 people), one request | 1,170 ms | 170 ms |
| Week grid, throughput | 0.9 req/s | 8 req/s |
| Staff list (50 people), 5 connections | 52 req/s, p50 383 ms, 58 errors | 90 to 120 req/s, p50 40 to 55 ms, no errors |
| Kiosk roster (100 people on the plan) | 0 (did not finish) / 27 req/s | 480 to 560 req/s, p50 35 ms |
| Kiosk heartbeat | 1,181 req/s | 4,800 to 5,100 req/s |
| Employee home | 576 req/s, 11 errors | 570 to 700 req/s, no errors |
| `GET /me` (the authentication path) | 994 req/s | 890 to 1,070 req/s |

What the measurements found and what was done:
1. **A race that returned HTTP 500**: the first read of a year's vacation allowance inserted the row; two concurrent requests collided on the unique key. Now `INSERT ... ON CONFLICT DO NOTHING` plus a read (test: `concurrency.test.ts`, fails without the fix).
2. **Time zone conversion was the top CPU cost** (17 % of the grid): date-fns-tz builds a new `Intl.DateTimeFormat` on every call. `lib/time.ts` now reads the zone's offset once per quarter hour and zone; results are identical to date-fns-tz for five zones, three years, every 7 minutes (instants) and every 30 minutes (wall clock, including all DST gaps and repeats), tested in `time.test.ts`.
3. **The grid loaded two years of schedule history per person** for the Sunday and night-work statistics. Day shifts on weekdays are now skipped in SQL (a night shift must start before 06:00, end after 23:00 or run past midnight).
4. **Staff list N+1**: hotel time zone, contract and vacation row were queried per person (about 450 queries per page); now per hotel and once per page, and time accounts run six at a time.
5. **Missing index** `punch_record(schedule_id)` (migration 013): the roster polled by every tablet every 20 s scanned the whole punch table (52 ms of a 90 ms request).
6. **Kiosk reference tokens**: the roster signed one token per person per poll, one after the other; tokens with more than two minutes of validity are reused and signing runs in parallel.
7. **Kiosk device `last_seen_at`** was written on every tablet request; "online" means seen within three minutes, so it is written at most every 30 seconds.
8. Measured and left alone: PDF timesheets take about 20 ms and the schedule Excel about 30 ms on top of the grid, so moving exports to a worker thread would add complexity without a gain. The job worker process from the earlier step stays.

Limits of these numbers: one machine, the database on the same host, synthetic data with a regular shape (one shift per person and day). Real hardware, network latency and real data will differ; use the script to measure before sizing.

## Costs and limits
- Each index makes writes a little slower and takes disk space; the partial ones are small. Every index here has a query in `queries.sql` that uses it.
- On a large live table create the indexes with `CREATE INDEX CONCURRENTLY` (outside the migration runner's transaction) to avoid blocking writes.
- Done afterwards: the permission lookup is cached per process for `PRINCIPAL_CACHE_MS` (default 5 s; role, hotel-scope and account-status changes reach a running process after at most that long; set 0 to turn it off); background jobs can run in their own process (`RUN_JOBS=false` on API processes, `node apps/api/dist/worker.mjs` for the jobs) and a database advisory lock lets only one process run a tick, so two API instances no longer duplicate jobs; every web page is its own chunk (lazy routes), so a phone loads the portal only.
- Exports and the roster were measured later (see "Load test and what it found").

