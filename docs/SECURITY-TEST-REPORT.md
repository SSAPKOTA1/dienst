# Security test report

Run on 2026-10-05 against the combined branch (all five improvement steps), demo seed, API started with `pnpm --filter @dienst/api start`.

## What was run
| Test | Result |
| --- | --- |
| Lint, typecheck, 54 rules tests, 1207 API tests (coverage floors) | pass |
| 32 Playwright e2e tests incl. 5 axe accessibility scans | pass |
| `pnpm audit` (full) | 1 high, dev-only (braces via kysely-codegen, no fix), ignored on purpose |
| `scripts/security/probe.mjs` (live black-box probe, 46 checks) | 46/46 pass |
| Refresh-token rotation, reuse, forged token, foreign `Origin` | pass after fix (see below) |
| Stored XSS payload in a name, rendered in the real web build (production CSP) | shown as text, not executed; injected inline script blocked by CSP; no token in browser storage |
| CSV export formula injection | cells starting with `= + - @` are neutralised |

The probe covers: 401 on every protected route without a token (255 operations from the generated OpenAPI), `alg=none` and edited-claim tokens, token of the wrong purpose, employee and manager role matrix on planner/admin routes, cross-hotel IDOR on employee records, hostile input on every GET and write route (no 5xx, no stack traces or SQL in errors), malformed and oversized bodies, account lockout and PIN lockout, user enumeration on login and password reset, kiosk token checks, secrets in responses, headers, CORS, cookie flags, SSRF through SSO configuration, public API key scopes, audit chain verification, data export logging.

## Finding fixed during this run
- **Refresh and logout accepted a foreign `Origin`.** The cookie is `SameSite=Strict`, which stops other sites, but not a sibling subdomain or a tricked browser setting. `POST /auth/refresh` and `/auth/logout` now answer 403 when the request carries an `Origin` other than `WEB_ORIGIN` (`lib/cookies.ts`, test in `cookies.test.ts`). Requests without `Origin` (scripts) are unaffected. `WEB_ORIGIN` must equal the public URL of the web app.

## Test-suite fix
- `e2e/tests/requests.spec.ts` assumed exactly one "Abweichung" row; the demo seed creates more later in the day. It now takes the first.

## Not covered (be honest about it)
- No penetration test by a third party, no fuzzing of PDF/Excel/CSV import parsers beyond the existing import tests, no load or denial-of-service test, no test of the production TLS/nginx stack in this run (covered by `scripts/ops/smoke-web.sh`, which needs Docker; the Docker daemon was not available in this session).
- Secret scan (gitleaks) could not run this time (no Docker); the last full-history run was clean, and CI runs it on every push.
- The principal cache means a blocked account or changed role can stay effective for up to `PRINCIPAL_CACHE_MS` (default 5 s) in a running process.
- Rate-limit values were raised for the test run; production defaults are tested in `hardening.test.ts`.

Re-run the probe: start the API on the demo seed, then `node scripts/security/probe.mjs`.
