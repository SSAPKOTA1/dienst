#!/usr/bin/env bash
# Runs once when the codespace is created: dependencies, .env, database schema and demo data.
set -euo pipefail
cd "$(dirname "$0")/.."

# the address the browser uses; the API compares the request origin with WEB_ORIGIN (CSRF, cookies)
if [ -n "${CODESPACE_NAME:-}" ]; then
  WEB_ORIGIN="https://${CODESPACE_NAME}-5173.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
else
  WEB_ORIGIN="http://localhost:5173"
fi

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i \
    -e "s|^DATABASE_URL=.*|DATABASE_URL=postgres://dienst:dienst@db:5432/dienst|" \
    -e "s|^TEST_DATABASE_URL=.*|TEST_DATABASE_URL=postgres://dienst:dienst@db:5432/dienst_test|" \
    -e "s|^SMTP_HOST=.*|SMTP_HOST=mailhog|" \
    -e "s|^WEB_ORIGIN=.*|WEB_ORIGIN=${WEB_ORIGIN}|" \
    .env
fi

pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed | tee .devcontainer/demo-logins.txt
echo
echo "Setup done. The app starts automatically; open the forwarded port 5173."
echo "Demo logins are saved in .devcontainer/demo-logins.txt (password for all: Demo!2345)."
