# Operations runbook

Audience: whoever runs the system. Everything here has a script or a command that was tested; see `scripts/ops`.

## 1. What runs
| Part | Image / process | Port | Health |
|---|---|---|---|
| `web` | nginx with the built web app (`docker build --target web`) | 8080 | `GET /healthz` |
| `api` | Node (`docker build --target api`), `node apps/api/dist/server.mjs` | 3000 | `GET /api/v1/health/live` (process), `/api/v1/health/ready` (database reachable, migrations applied, not shutting down) |
| `migrate` | same image, `node apps/api/dist/migrate.mjs`, runs once per deploy | – | exit code |
| `db` | PostgreSQL 16 | 5432 | `pg_isready` |

Put TLS termination (load balancer or ingress) in front of `web`. Only `web` is reachable from outside; it proxies `/api/`.

## 2. Deploy
```
cp .env.production.example .env.production        # first time: fill in secrets (openssl rand -hex 32)
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```
Order is enforced by compose: `db` healthy → `migrate` completes → `api` ready → `web`. Migrations take an advisory lock, so two deploys starting together are safe. A rolling update works because the API drains: on SIGTERM readiness turns 503 (the balancer stops sending traffic), in-flight requests finish, then the process exits 0 (`stop_grace_period: 30s`).

Check afterwards: `curl -fs https://HOST/api/v1/health/ready` → `{"status":"ready"}`.

## 3. Roll back
1. Code only (no migration in the release): redeploy the previous image tag.
2. With a migration: roll the code back **first**, then the schema if needed: `docker compose run --rm migrate node apps/api/dist/migrate.mjs --rollback 1` (undoes the newest migration with its `.down.sql`; data in dropped columns/tables is lost, restore a backup if it matters). Migrations 002 to 004 and 001 have no down file and cannot be rolled back; a rollback stops there with an error.
3. If in doubt, restore the backup taken before the deploy (section 5).

## 4. Configuration that must be right in production
`NODE_ENV=production`, `COOKIE_SECURE=true`, `WEB_ORIGIN`, `JWT_SECRET` and `DATA_KEY` (different, random), `TRUST_PROXY=1` behind one proxy, `METRICS_TOKEN` if metrics are scraped. The API refuses to start with development secrets. See `docs/DEPLOYMENT.md` for keys, proxies and cookies.

## 5. Backups and restore
- **Back up** (nightly, cron): `DATABASE_URL=... BACKUP_DIR=/backups BACKUP_AGE_RECIPIENT=age1... scripts/ops/backup.sh`. Custom-format dump, SHA-256 file, optional age encryption, rotation after `BACKUP_KEEP_DAYS` (default 14). Copy the directory off the host (object storage). Keep the age private key somewhere else than the backups.
- **Restore drill** (weekly, and after any change): `DATABASE_URL=... BACKUP_DIR=/backups scripts/ops/restore-drill.sh`. It restores the newest backup into a temporary database, checks the data (tables, migrations, audit hash chains) and drops it again. The time it prints is your restore time. A failing drill is an incident: the backups cannot be trusted.
- **Restore for real:** create an empty database, `BACKUP_AGE_IDENTITY=key.txt scripts/ops/restore.sh FILE TARGET_URL` (refuses a non-empty database or a damaged file), point the API at it, start it (it applies newer migrations).
- Documents are stored in the database (encrypted), so a database backup is a complete backup. `DATA_KEY` (and a previous one, if rotating) is **not** in the backup: store it separately, without it documents and TOTP secrets cannot be read.

## 6. Monitoring
- **Metrics** (`GET /metrics`, bearer `METRICS_TOKEN`; off in production without a token): `http_request_duration_seconds` (by route pattern and status class), `login_failures_total`, `punches_total{source,action,outcome}`, `job_runs_total{job,outcome}`, `job_last_success_timestamp_seconds{job}`, `server_errors_total`, `db_pool_*`, plus process metrics.
- **Alert rules** (Prometheus): `deploy/alerts.yml`. They cover: API down or not ready, 5xx rate, slow requests, login failure bursts, a background job that failed or has not run, database pool exhausted, backups too old.
- **Errors:** set `ERROR_WEBHOOK_URL` to receive a JSON message for every new server error (at most one per error every 30 s, no request data). Every response carries `X-Request-Id`; the same id is in the API log line of that request. Ask users for it.
- **Logs** are JSON (pino) on stdout; tokens, PINs, passwords and cookies are redacted.

## 7. Incident checklist
1. Is `web` up (`/healthz`)? Is the API ready (`/api/v1/health/ready`)? The body names the reason: `database_unreachable`, `migrations_pending`, `shutting_down`.
2. Look at the alerts and at `server_errors_total`, then at the logs for the request id.
3. Database full or slow: check disk and `db_pool_waiting_requests`; indexes are in `docs/PERFORMANCE.md`.
4. Suspected data tampering: Admin → Protokoll → "Integrität prüfen" (or `GET /audit-log/verify`) recomputes the hash chains.
5. Leaked secret: rotate it (`docs/DEPLOYMENT.md`, keys), revoke API keys (Admin → Schnittstellen), sign everyone out by changing `JWT_SECRET` without a `*_PREVIOUS` value.
6. After the incident: write down what happened and what changed.

## 8. Routine tasks
| Task | How often | How |
|---|---|---|
| Backup + copy off site | daily | `backup.sh` |
| Restore drill | weekly | `restore-drill.sh` |
| Dependency updates | weekly (Dependabot PRs) | review, merge when CI is green |
| Key rotation | yearly or after a leak | `docs/DEPLOYMENT.md` |
| Check API keys near expiry | monthly | Admin → Schnittstellen |
