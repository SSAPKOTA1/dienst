# syntax=docker/dockerfile:1
# Two images from one file:  --target api  (the API, also used for migrations and jobs)
#                            --target web  (nginx serving the built web app with the security headers)

FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app
# dependency layer: only manifests, so it is cached until a dependency changes
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/rules/package.json packages/rules/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build
# the API's production dependencies only (no dev tools, no test runner); the workspace packages are bundled into dist
RUN pnpm --filter @dienst/api --prod deploy --legacy /deploy

FROM node:22-slim AS api
ENV NODE_ENV=production MIGRATIONS_DIR=/app/db/migrations
# the runtime only runs `node`; the package managers bundled in the base image are unused attack surface (and what image scans flag)
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-*
WORKDIR /app
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /deploy/package.json ./package.json
COPY db/migrations ./db/migrations
USER node
EXPOSE 3000
# node handles SIGTERM itself (drain, then exit: apps/api/src/server.ts). Run with an init process (`docker run --init`,
# compose `init: true`) so that zombie processes are reaped.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.mjs"]

# the unprivileged variant runs as user 101 and listens on 8080 (needed for a read-only, non-root pod)
FROM nginxinc/nginx-unprivileged:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080

# Backups and restore drills: pg_dump / pg_restore 16, age, the scripts of scripts/ops, and the node runtime plus the
# bundled drill (data checks run through the application code). Debian based like the api image, so native modules match.
FROM postgres:16 AS ops
RUN apt-get update && apt-get install -y --no-install-recommends age && rm -rf /var/lib/apt/lists/*
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=build /deploy/node_modules /app/node_modules
COPY --from=build /app/apps/api/dist/drill.mjs /app/apps/api/dist/drill.mjs
COPY --from=build /deploy/package.json /app/package.json
COPY scripts/ops/backup.sh scripts/ops/restore.sh scripts/ops/restore-drill.sh /opt/ops/
RUN chmod +x /opt/ops/*.sh
ENV DRILL_SCRIPT=/app/apps/api/dist/drill.mjs
USER postgres
ENTRYPOINT ["/opt/ops/backup.sh"]
