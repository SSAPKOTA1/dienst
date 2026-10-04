# PROGRESS

## M0 Scaffold - done
- Monorepo (pnpm workspaces): `apps/api`, `apps/web`, `packages/shared`, `packages/rules`; migration runner + `001_init.sql`; Kysely types generated; health endpoint; web shell with tokens, Archivo, DE/EN switch and the prototype navigation; CI workflow, `.env.example`, ESLint/Prettier.
- Tests: rules vectors (14), API health (2). lint, typecheck, test green.
- Compared the shell with `design/prototype.html` by screenshot (nav, language switch).

## M1 Auth and roles - done
- Login by e-mail/username, pre-role token + role selector, switch-role, rotating refresh cookie, invitation/activation (link and code), forgot/reset, TOTP setup/verify, lockout, rate limits, scope resolver (`lib/scope.ts`), `requireRole`, audit helper with hash chain + append-only trigger, `/me`.
- Web: login (credentials, TOTP, role selector, 2FA setup), accept-invitation (link or username+code), forgot-password, auth context with silent refresh, account menu (role switch, logout).
- Tests: 15 API integration tests (auth) + rules (16). lint/typecheck/test green.
