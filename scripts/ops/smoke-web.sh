#!/usr/bin/env bash
# Checks the web image: every kind of response carries the security headers, single-page routes fall back to
# index.html, assets are cached for a year and index.html/sw.js are not.   smoke-web.sh <image>
set -euo pipefail
IMAGE="${1:?usage: smoke-web.sh <image>}"
NAME="dienst-web-smoke-$$"
PORT="${SMOKE_WEB_PORT:-18080}"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
docker run -d --name "$NAME" --add-host api:127.0.0.1 -p "$PORT:8080" "$IMAGE" >/dev/null
for _ in $(seq 1 30); do curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
ASSET="$(curl -s "http://127.0.0.1:$PORT/" | grep -o '/assets/[^"]*\.js' | head -1)"
[[ -n "$ASSET" ]] || fail "no asset in index.html"
for path in / /me/schedule /index.html /sw.js "$ASSET" /healthz /does/not/exist.png; do
  H="$(curl -s -o /dev/null -D - "http://127.0.0.1:$PORT$path")" # headers only
  for h in content-security-policy strict-transport-security x-content-type-options x-frame-options referrer-policy permissions-policy cross-origin-opener-policy; do
    grep -qi "^$h:" <<<"$H" || fail "$path lacks $h"
  done
done
grep -qi "^cache-control: no-cache" <<<"$(curl -s -o /dev/null -D - "http://127.0.0.1:$PORT/index.html")" || fail "index.html is cached"
grep -qi "^cache-control: no-cache" <<<"$(curl -s -o /dev/null -D - "http://127.0.0.1:$PORT/sw.js")" || fail "sw.js is cached"
grep -qi "^cache-control: public, max-age=31536000, immutable" <<<"$(curl -s -o /dev/null -D - "http://127.0.0.1:$PORT$ASSET")" || fail "assets not cached long"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/me/schedule")" == "200" ]] || fail "SPA fallback broken"
grep -qi "^server: nginx/" <<<"$(curl -s -o /dev/null -D - "http://127.0.0.1:$PORT/")" && fail "nginx version is announced"
echo "web container smoke test: all checks passed"
