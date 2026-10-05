# Dienst - hotel attendance and scheduling

Workforce scheduling, kiosk time clock, approvals and month close for German hotels (multi-company, multi-hotel; ArbZG, BUrlG, JArbSchG). German is the default language, English can be switched in the header.

**Stack:** pnpm workspaces, Node 22, TypeScript strict. `apps/api` Fastify 5 + Kysely + PostgreSQL 16, `apps/web` React 18 + Vite + Tailwind, `packages/rules` (pure legal and planning rules), `packages/shared` (schemas, error codes). Tests: Vitest (unit and API integration against a real Postgres) and Playwright (e2e).

## Quick start

Prerequisites: Node 22, pnpm 10, Docker (or a local PostgreSQL 16 with a `dienst` user and database), Chromium for the e2e tests (`pnpm exec playwright install chromium`, or set `CHROMIUM_PATH`).

```bash
pnpm install
cp .env.example .env            # git-ignored; adjust secrets for anything but local development
docker compose up -d db         # add `mailhog` to read invitation mails at http://localhost:8025
pnpm db:migrate                 # applies db/migrations/*.sql (001 = db/schema_v1.sql)
pnpm db:seed                    # demo data, prints logins, PINs and the tablet token
pnpm dev                        # API on :3000, web on :5173
```

Open <http://localhost:5173>. `pnpm db:seed` always wipes the database and reseeds it relative to today.

## Demo logins

Password for every demo account: **`Demo!2345`**.

| Who | Login | Notes |
|---|---|---|
| Super admin | `sa@demo.test` | needs a TOTP code |
| Admin (Anna Krüger) | `admin@demo.test` | needs a TOTP code |
| Manager Frankfurt (Markus Lehmann) | `manager@demo.test` | reduced view of Berlin staff |
| Employees | `maria.garcia`, `jon.schmidt`, `aylin.demir`, ... or `<username>@demo.test` | open the mobile portal at `/me` |

TOTP secret for `sa@` and `admin@` (add it to any authenticator app): `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`.

Tablet (kiosk): open `/kiosk` on the tablet, the demo device token is `kd_demo_frankfurt_4f1c9a7e2b6d8035a1e94c7b02d6f83a` (in a real setup an admin pairs a tablet under Admin > Tablets and enters the one-time code shown there). Demo PINs (6 digits): Maria 482915, Jon 736204, Aylin 159357, Lena 864219, Piotr 297031, Fatima 513684, Sven 640872, Elena 925461, Tom 371596, Clara 708342, Ömer 246813, Hannah 581927, Dmitri 439065, Sophie 862710, Nina 195837. Sven has no e-mail: the seed prints his activation code (use it with his username at `/accept-invitation`).

Backlog demo data (mostly in the Berlin hotel, which the admin sees): Berlin tablet token `kd_demo_berlin_8b2e5d1c7a9f4630c2e81d5b9a7f3e04` (break start/stop, badge + PIN), badge of Clara Neumann `B-DEMO-CLARA-0001`, web punch allowed from `10.0.0.0/8`, read-only public API key `dk_demo_readonly_5c8e2a9f1b7d4630a2e91c5d8b7f3a06` (see `docs/PUBLIC-API.md`). The seed also creates occupancy forecasts and staffing rules, a blackout period, leave and shift wishes, qualifications (one expiring), an availability window, a hygiene document, an open shift with an application, a swap offer, announcements (one needs read confirmation), a feed post and a question to management. SSO is not seeded because it needs a reachable identity provider.

## Commands

```bash
pnpm test           # unit + API integration tests (creates and wipes the dienst_test database)
pnpm e2e            # Playwright; starts/reuses the API and web server and reseeds the dev database
pnpm lint && pnpm typecheck
pnpm db:codegen     # regenerate apps/api/src/db/types.ts after a migration
```

Use `RATE_LIMIT_AUTH=1000 RATE_LIMIT_GLOBAL=100000` for the API when you run the e2e suite against a server you started yourself (the Playwright config sets this when it starts the server).

## What is built (v1)

Accounts and roles with role selector and TOTP for admins; automatic employee accounts (invitation link or activation code); companies, hotels, departments, shift templates and required headcount; employees with contracts, PINs and the computed time account; the Dienstplan (employee and shift view, drag and drop, keyboard path, draft/published with change panel and revert, substitute finder, absences, rule checks with emergency override); tablet kiosk (name + PIN, break confirmation, grace period, unplanned punches, auto-checkout, heartbeat); Live view; approvals, corrections, vacation requests; hours-visibility setting; month close and reopen; schedule Excel, timesheet PDF/Excel, attendance and audit CSV; employee portal; admin setup (hotels, users, tablets, read-only rules, audit log, onboarding checklist); employee Excel import with dry run, error CSV and a one-time credentials sheet.

## What is built (backlog, M10-M13)

Leave: blackout periods, half days, vacation planner, wishes, notices and carryover, month overview. Hours: time-account ledger, hour categories, payroll export (hours only), rest-period compensation, Sunday and night-worker checks, stricter-only rule profiles, feature toggles, analytics. Collaboration: shift swaps, open shifts, availability, qualifications, encrypted documents, offboarding, announcements, questions, feed, calendar subscription. Platform: break start/stop, badge identification, web punch (hotel network only), offline kiosk queue, occupancy staffing suggestions, read-only public API with keys (`docs/PUBLIC-API.md`), OpenID Connect SSO, installable PWA. Specification: `docs/BACKLOG-SPEC.md`.

Still excluded on purpose: wage or hourly-rate fields, employee sick reporting (planners mark sickness), biometrics, GPS or location tracking, native apps (the PWA is provided instead).

## Layout

```
apps/api        Fastify API (routes, services, jobs, seed) and its tests
apps/web        React app (planner, kiosk, portal, admin)
packages/rules  pure rule functions (breaks, grace, rest period, minors, vacation, time account, checks)
packages/shared zod schemas, error codes, constants
db/migrations   plain SQL migrations (applied by apps/api/src/db/migrate.ts)
e2e             Playwright tests
docs            DECISIONS.md (every ambiguity and how it was resolved), PROGRESS.md, full-spec.md (backlog reference)
```

## Security notes

- Authorization is one layer (`requireRole` + a scope resolver rebuilt from the database for every request); every query on hotel or employee data filters by scope.
- Passwords (min. 10 characters) and PINs are hashed with argon2id; PINs, passwords and tokens never appear in logs or mails. Refresh tokens rotate and are revoked on reuse; five wrong passwords lock the account, five wrong PINs lock the employee for 15 minutes.
- Every state-changing endpoint runs in one transaction, validates with zod and writes a hash-chained, append-only `audit_log` row.
- Helmet headers, CORS limited to `WEB_ORIGIN`, rate limits (`RATE_LIMIT_AUTH`, `RATE_LIMIT_KIOSK`, `RATE_LIMIT_GLOBAL` per minute and client).

## Production notes

Security headers, CORS and the reverse-proxy setup are described in `docs/DEPLOYMENT.md`.

- Set `NODE_ENV=production`, a long random `JWT_SECRET`, a fresh `TOTP_ENC_KEY` (64 hex characters) and `COOKIE_SECURE=true`; the API refuses to start with the development secrets.
- Behind a reverse proxy set `TRUST_PROXY` to the number of proxies (e.g. `1`) or their addresses so rate limits, the web punch check and the audit log see the client address (`docs/DEPLOYMENT.md`); `true` is refused in production.
- Configure SMTP (`SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM`) for invitation and password-reset mails; with `MAIL_MODE=json` mails are only logged (development).
- Build the web app with `pnpm build` and serve `apps/web/dist` behind the same host as `/api`.

## Source documents

`SPEC.md` (behaviour) > `design/DESIGN.md` and `design/prototype.html` (UI) > `db/schema_v1.sql` > `tests/` (rule vectors) > `docs/full-spec.md` (backlog reference only). `CLAUDE.md` holds the project rules.
