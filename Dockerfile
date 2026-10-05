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

FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
