#!/usr/bin/env bash
# Starts the API image against a throwaway database and checks what an orchestrator relies on: migrations run,
# liveness and readiness answer, metrics need the token, the container runs read-only as a non-root user, and
# SIGTERM drains (readiness 503 first) and exits 0.
#   smoke-container.sh <image> [postgres admin url, default postgres://dienst:dienst@localhost:5432/postgres]
set -euo pipefail
IMAGE="${1:?usage: smoke-container.sh <image> [admin url]}"
ADMIN="${2:-postgres://dienst:dienst@localhost:5432/postgres}"
DB="dienst_smoke_$$"
URL="${ADMIN%/*}/$DB"
PORT="${SMOKE_PORT:-3199}"
NAME="dienst-smoke-$$"
fail() { echo "FAIL: $*" >&2; docker logs "$NAME" 2>&1 | tail -20 >&2 || true; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; psql "$ADMIN" -qc "drop database if exists $DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT
psql "$ADMIN" -qc "create database $DB"
# a container reaches the database of the host through the host network; inside compose it is `db`
NET=(--network=host)
ENVS=(-e NODE_ENV=production -e DATABASE_URL="${URL}" -e JWT_SECRET="$(openssl rand -hex 32)" -e DATA_KEY="$(openssl rand -hex 32)"
      -e COOKIE_SECURE=true -e WEB_ORIGIN=https://dienst.example.test -e TRUST_PROXY=1 -e METRICS_TOKEN=smoke-metrics-token-123 -e API_PORT="$PORT"
      -e SHUTDOWN_DRAIN_MS=3000)

echo "1. migrations run in the image"
docker run --rm "${NET[@]}" "${ENVS[@]}" "$IMAGE" node apps/api/dist/migrate.mjs | tail -2
[[ "$(psql "$URL" -Atc 'select count(*) from schema_migrations')" -ge 10 ]] || fail "migrations not recorded"

echo "2. the API starts read-only, as a non-root user, with an init process"
docker run -d --name "$NAME" --init --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true "${NET[@]}" "${ENVS[@]}" "$IMAGE" >/dev/null
for _ in $(seq 1 40); do curl -fs "http://127.0.0.1:$PORT/api/v1/health/live" >/dev/null 2>&1 && break; sleep 0.5; done
LIVE="$(curl -fs "http://127.0.0.1:$PORT/api/v1/health/live")" || fail "not live"
grep -q live <<<"$LIVE" || fail "not live"
[[ "$(docker exec "$NAME" id -u)" != "0" ]] || fail "runs as root"

echo "3. readiness, request id, security headers"
READY="$(curl -fs "http://127.0.0.1:$PORT/api/v1/health/ready")" || fail "not ready"
grep -q ready <<<"$READY" || fail "not ready"
H="$(curl -si -H 'X-Request-Id: smoke-req-0001' "http://127.0.0.1:$PORT/api/v1/health")"
echo "$H" | grep -qi '^x-request-id: smoke-req-0001' || fail "request id not echoed"
echo "$H" | grep -qi '^strict-transport-security:' || fail "no HSTS in production"
echo "$H" | grep -qi "^content-security-policy: default-src 'none'" || fail "no CSP"

echo "4. metrics need the token"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/metrics")" == "401" ]] || fail "metrics open without token"
METRICS="$(curl -fs -H 'Authorization: Bearer smoke-metrics-token-123' "http://127.0.0.1:$PORT/metrics")" || fail "no metrics"
grep -q http_request_duration_seconds <<<"$METRICS" || fail "no metrics"

echo "5. SIGTERM drains: readiness turns 503, then the process exits 0"
docker kill --signal=SIGTERM "$NAME" >/dev/null
sleep 1
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/v1/health/ready" || true)"
[[ "$CODE" == "503" ]] || fail "readiness during drain was $CODE, expected 503"
EXIT="$(docker wait "$NAME")"
[[ "$EXIT" == "0" ]] || fail "exit code $EXIT, expected 0"
LOGS="$(docker logs "$NAME" 2>&1)"
grep -q "shutting down" <<<"$LOGS" || fail "no shutdown log"
echo "container smoke test: all checks passed"
