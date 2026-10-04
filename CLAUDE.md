# CLAUDE.md - Hotel Attendance & Scheduling App

Workforce scheduling, kiosk time clock, approvals and month close for German hotels. Multi-company, multi-hotel. German working-time law matters (ArbZG, BUrlG, JArbSchG).

## Source of truth (in this order)
1. `SPEC.md` - what to build in v1. Follow it literally.
2. `design/DESIGN.md` and the prototype `design/prototype.html` - the look, screens and interaction details. `design/DESIGN.md` section 4 lists, per screen, what is built in v1, what is v2 (do not build) and where SPEC.md overrides the prototype. Behaviour, data, rules and API always come from SPEC.md.
3. `db/schema_v1.sql` - database. Do not change table or column names. If you must add a column, add a new migration file and note it in `docs/DECISIONS.md`.
4. `tests/vectors.json` and `tests/reference-rules.mjs` - exact expected results for the rule functions. Your implementation must reproduce every vector.
5. `docs/full-spec.md` - long reference for BACKLOG features only. Do NOT build anything from it that SPEC.md does not list.

If something is ambiguous: pick the simplest option consistent with SPEC.md, implement it, and append one line to `docs/DECISIONS.md` (decision + reason). Do not stop to ask unless a milestone is blocked.

## Fixed stack (do not substitute)
- Monorepo: pnpm workspaces, Node 22, TypeScript strict everywhere.
- `apps/api`: Fastify 5, zod (fastify-type-provider-zod), Kysely + `pg`, `argon2`, `jose` (JWT), `otplib` (TOTP), `pdfkit`, `exceljs`, `nodemailer`, `pino`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/cookie`.
- `apps/web`: React 18, Vite, TypeScript, Tailwind CSS (configured from `design/tokens.css`, Archivo font from `design/fonts` or `@fontsource-variable/archivo`, radius 0), React Router, TanStack Query, `@dnd-kit/core`, `date-fns` + `date-fns-tz`, `react-i18next` (en + de).
- `packages/shared`: zod schemas, DTO types, error codes, constants.
- `packages/rules`: pure functions only (no IO, no DB, no Date.now). Used by the API.
- Database: PostgreSQL 16 (docker compose). Plain SQL migrations in `db/migrations/` applied by a small runner (`apps/api/src/db/migrate.ts`); `001_init.sql` is a copy of `db/schema_v1.sql`.
- Tests: Vitest (unit + API integration against a real Postgres), Playwright (e2e at the end).
- Lint/format: ESLint + Prettier. CI: GitHub Actions running lint, typecheck, test.

## Commands (create these scripts in root package.json)
```
pnpm install
docker compose up -d db
pnpm db:migrate        # apply db/migrations
pnpm db:seed           # demo data, prints dev logins and PINs
pnpm dev               # api on :3000, web on :5173
pnpm test              # unit + integration
pnpm e2e               # Playwright
pnpm lint && pnpm typecheck
```

## Conventions
- API base path `/api/v1`. JSON in camelCase, database in snake_case. Dates `YYYY-MM-DD`, timestamps ISO-8601 with offset.
- Store all timestamps as UTC. Each hotel has `timezone` (default `Europe/Berlin`). `shift_date` is the hotel-local START date. Never compute durations from stored hour numbers; always from timestamps (daylight saving).
- IDs are integers. No money, no wages, no payroll calculation anywhere.
- One authorization layer: `requireRole(...)` + a `scope` resolver that returns the company ids and hotel ids the caller may touch. Every query on hotel- or employee-bound data filters by scope. Never trust ids from the client.
- Every state-changing endpoint: runs in one DB transaction, validates with zod, writes an `audit_log` row (actor, role, action, entity, old/new, reason).
- Legal and planning rules live ONLY in `packages/rules` and are called by the API. The browser never decides legality; it only displays server results.
- Errors use the format in SPEC.md section 5 (`error.code`, `error.message`, `error.details`).
- Onboarding an employee ALWAYS creates or links a `user_account` and assigns the employee role automatically (SPEC.md 4.14). There are no employees without an account.
- Passwords: min 10 characters, argon2id. PINs: argon2id, never logged, never emailed, shown once.
- Logs must not contain PINs, passwords, tokens or full names.
- All user-facing strings go through i18n (`en`, `de`); seed the catalogues from `design/i18n-de-en.json`. German is the default UI language and the default language of generated PDFs.
- Accessibility: keyboard operable planning grid, visible focus, never colour alone.

## Definition of done (every milestone)
1. Code compiles, lint and typecheck pass.
2. Tests listed for the milestone exist and pass (`pnpm test`).
3. The milestone's "Done when" check in SPEC.md section 9 passes.
4. One git commit per milestone: `M<n>: <title>`.
5. `docs/DECISIONS.md` updated if you made a choice.

## Backlog build (owner approved)
After v1 (M0-M9) the backlog of SPEC section 10 is being built as M10-M13, specified in `docs/BACKLOG-SPEC.md`. Still excluded: biometrics, GPS, employee sick reporting, wage/hourly-rate fields.

## Do NOT
- Build backlog features that `docs/BACKLOG-SPEC.md` does not list (the v1 "do not build" list below is superseded for those that it does) (SPEC.md section 10; `design/DESIGN.md` marks them v2): the Urlaub planner, wishes, questions to management, blackout periods, month overview, vacation notices, time account ledger, shift swaps, open shifts, availability, qualifications, documents, social feed, payroll export, occupancy staffing, SSO, offline kiosk.
- Add wage or hourly-rate fields, an employee "Krank melden" action (planners mark sickness on the plan), biometrics, GPS, or any employee scoring/ranking.
- Weaken a rule (e.g. turn a `blocked` result into a warning) to make a test pass.
- Put secrets in the repo. Use `.env` (git-ignored) and commit `.env.example`.
- Create extra tables or rename columns without a migration and a DECISIONS entry.

## Working style
Work milestone by milestone (SPEC.md section 9). After each milestone: run all tests, commit, and print a 5-line status (done, tests, open decisions). Continue automatically to the next milestone unless tests are red.
