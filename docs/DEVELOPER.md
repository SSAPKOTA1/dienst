# Developer onboarding

From a fresh clone to a green test run and your first change. Target: **under 30 minutes**.

## 1. Prerequisites

Node 22, pnpm 10 (`corepack enable`), PostgreSQL 16 (Docker is easiest), Chromium for the e2e tests (`pnpm exec playwright install chromium`).

## 2. First run

```bash
pnpm install
cp .env.example .env
docker compose up -d db          # or a local PostgreSQL with user/db "dienst"
pnpm db:migrate && pnpm db:seed  # demo data; prints logins, PINs, tablet tokens
pnpm dev                         # API :3000, web :5173
```

Sign in with `admin@demo.test` / `Demo!2345` (+ TOTP secret from the README), `manager@demo.test`, or `maria.garcia` (employee). `/kiosk` is the tablet.

## 3. Where things are

| Path | What |
|---|---|
| `packages/rules` | pure legal/planning rules; **the only place legality is decided** (no IO, no clock) |
| `packages/shared` | zod schemas, DTO types (`dto.ts`, generated `responses.ts`), error codes |
| `apps/api/src/routes` | one Fastify plugin per area; `services/` shared logic; `lib/` cross-cutting (auth, scope, time, crypto) |
| `apps/api/src/jobs` | background jobs (`scheduler.ts`), run by `worker.ts` |
| `apps/web/src/pages` | screens (`planning/`, `portal/`, `kiosk/`, `admin/`) |
| `db/migrations` | plain SQL, `NNN_name.sql` (+ `.down.sql`); `001` is `db/schema_v1.sql` |
| `e2e` | Playwright specs (a11y checks included) |
| `scripts/{ops,perf,security,types,ci}` | backups, load tests, probes, type generation, CI helpers |
| `deploy` | Kubernetes, VM, monitoring, alerts |

Source of truth order (`CLAUDE.md`): `SPEC.md` → `design/` → `db/schema_v1.sql` → `tests/vectors.json` + `reference-rules.mjs` → `docs/full-spec.md` (backlog only). Backlog spec: `docs/BACKLOG-SPEC.md`. Every ambiguity and its resolution: `docs/DECISIONS.md`.

## 4. Everyday commands

```bash
pnpm test                 # unit + API integration (real Postgres, wipes dienst_test)
pnpm test:coverage        # with the coverage floors CI enforces
pnpm e2e                  # Playwright, reseeds the dev database
pnpm exec playwright test -c e2e/playwright.config.ts planning   # one spec
pnpm lint && pnpm typecheck
pnpm mutation             # Stryker on packages/rules (slow; CI runs it weekly)
pnpm docs:api             # regenerate docs/api (CI fails when stale)
pnpm db:codegen           # after a migration: regenerate Kysely types
```

## 5. How to make a change

1. **Behaviour** comes from `SPEC.md`/`BACKLOG-SPEC.md`. Do not build what they do not list. No wages, no biometrics, no GPS, no employee sick reporting.
2. **Rule or legal logic?** Put it in `packages/rules` with unit tests; add vectors to `tests/vectors.json` when the spec defines them. Never weaken a rule to make a test pass.
3. **Endpoint:** validate with zod, `requireRole(...)`, resolve the **scope** (company/hotel ids) and filter every query by it; run in one transaction; write an `audit_log` row (actor, role, action, entity, old/new, reason). Error format from `packages/shared/src/errors.ts`. Never trust ids from the client.
4. **Database:** do not rename columns. Add `NNN_name.sql` and `.down.sql`, run `pnpm db:codegen`, note it in `docs/DECISIONS.md`. Migrations must stay compatible with the previous release for one version (rolling deploys).
5. **Response shape:** annotate the row mapper with a type from `packages/shared/src/dto.ts` so the web build breaks when the server changes.
6. **UI:** all strings through i18n (`t('Deutscher Text')`, catalogue in `design/i18n-de-en.json`; `node scripts/i18n-missing.mjs` lists gaps); keyboard operable, visible focus, never colour alone (axe runs in e2e). German is the default language.
7. **Time:** store UTC; `shift_date` is the hotel-local start date; compute durations from timestamps, never from hour numbers (daylight saving). Use `apps/api/src/lib/time.ts`.
8. **Tests:** API integration test against Postgres for every endpoint (including a scope/other-company case), unit/property tests for rules, an e2e spec for new screens.
9. **Docs:** user-visible change → update `docs/manual/*` (de **and** en) and run `pnpm docs:api`.

## 5a. Pitfalls we have hit

- Do not `pkill -f` a pattern that matches your own shell; stop the dev API with `fuser -k 3000/tcp`.
- A TOTP code cannot be used twice in one 30 s window; when a script logs in as an admin twice, wait or use a fresh window.
- `pnpm e2e -- file` runs everything; use the `playwright test` form above for one spec.
- e2e global setup reseeds the database; do not run it against data you want to keep.
- `audit_log` is append-only; tests cannot backdate rows.

## 6. Pull requests

Branch from `main`, keep one topic per PR, fill in the template (`.github/pull_request_template.md`). CI must be green: lint, typecheck, tests with coverage, API-reference freshness, e2e (Chromium; Firefox and WebKit on the matrix), accessibility, container smoke tests, SBOM and vulnerability scan, CodeQL, secret scan, infrastructure validation. `CODEOWNERS` assigns reviewers. Use `Co-Authored-By` trailers for AI assistance. Security-relevant changes: mention them in the PR and in `docs/DECISIONS.md`; probe with `scripts/security/probe.mjs` (see `docs/SECURITY-TEST-REPORT.md`).

## 7. More

`docs/ARCHITECTURE.md` (layout, rules of the road, typed contracts), `docs/PERFORMANCE.md` (budgets, load tests), `docs/INFRASTRUCTURE.md` (release, deploy, monitoring), `docs/RUNBOOK.md` (operations), `docs/privacy/` (GDPR), `docs/REPO-SETTINGS.md` (branch protection and secrets to configure on GitHub).
