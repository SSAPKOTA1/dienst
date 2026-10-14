#!/usr/bin/env bash
# Runs every time the codespace starts: API on :3000 and web on :5173 in the background.
cd "$(dirname "$0")/.."
if ! curl -fsS http://localhost:3000/api/v1/health >/dev/null 2>&1; then
  nohup pnpm dev > /tmp/dienst-dev.log 2>&1 &
fi
