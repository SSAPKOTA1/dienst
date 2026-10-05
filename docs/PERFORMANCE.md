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

## Costs and limits
- Each index makes writes a little slower and takes disk space; the partial ones are small. Every index here has a query in `queries.sql` that uses it.
- On a large live table create the indexes with `CREATE INDEX CONCURRENTLY` (outside the migration runner's transaction) to avoid blocking writes.
- Done afterwards: the permission lookup is cached per process for `PRINCIPAL_CACHE_MS` (default 5 s; role, hotel-scope and account-status changes reach a running process after at most that long; set 0 to turn it off); background jobs can run in their own process (`RUN_JOBS=false` on API processes, `node apps/api/dist/worker.mjs` for the jobs) and a database advisory lock lets only one process run a tick, so two API instances no longer duplicate jobs; every web page is its own chunk (lazy routes), so a phone loads the portal only.
- Not done: moving PDF/Excel generation itself off the API process, and a roster cache (`/kiosk/roster` signs one token per person and is polled every 20 seconds per tablet; measure with `scripts/perf/load.js` first).

## Load test
`k6 run -e BASE=http://localhost:3000 -e LOGIN=... -e PASSWORD=... scripts/perf/load.js` (k6 is not in the repo's dependencies). It logs in, then polls `/me` (the authentication path every request pays) at a steady rate and fails the run when p95 is above 300 ms or more than 1 % of requests fail. Run it against a seeded copy, not production.
