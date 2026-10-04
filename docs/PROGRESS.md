# PROGRESS

## M0 Scaffold - done
- Monorepo (pnpm workspaces): `apps/api`, `apps/web`, `packages/shared`, `packages/rules`; migration runner + `001_init.sql`; Kysely types generated; health endpoint; web shell with tokens, Archivo, DE/EN switch and the prototype navigation; CI workflow, `.env.example`, ESLint/Prettier.
- Tests: rules vectors (14), API health (2). lint, typecheck, test green.
- Compared the shell with `design/prototype.html` by screenshot (nav, language switch).

## M1 Auth and roles - done
- Login by e-mail/username, pre-role token + role selector, switch-role, rotating refresh cookie, invitation/activation (link and code), forgot/reset, TOTP setup/verify, lockout, rate limits, scope resolver (`lib/scope.ts`), `requireRole`, audit helper with hash chain + append-only trigger, `/me`.
- Web: login (credentials, TOTP, role selector, 2FA setup), accept-invitation (link or username+code), forgot-password, auth context with silent refresh, account menu (role switch, logout).
- Tests: 15 API integration tests (auth) + rules (16). lint/typecheck/test green.

## M2 Organisation and employees - done
- API: companies, hotels (+settings), admins, managers, departments, kiosk devices, holidays (resolved), employees (create with automatic account, PIN, personnel number, proration; list/detail with home-hotel reduced view; contracts; reset/unlock PIN; resend invitation / reset activation; deactivate), time account, users list, setup status/overview.
- Web: Mitarbeiter (list + detail), create stepper with one-time result panel and slip print, Einrichtung (Übersicht with checklist, Hotels/Abteilungen, Benutzer & Rollen, Unternehmen for SA).
- Seed part 1: company, hotels, departments, users, 15 employees with fixed PINs, holidays 2026-27, kiosk device.
- Tests: org (7), employees (16), permission matrix, auth (13) -> 183 tests green; lint/typecheck green.

## M3 Shifts and staffing - done
- API: shift CRUD (`/shifts`, scope per hotel, delete blocked when used), staffing defaults/overrides (`/shifts/:id/staffing`), `resolveRequired` in `packages/rules`, staffing loader service.
- Web: Hotels tab shows shifts and minimum per department; "Schichten & Besetzung" dialog edits shifts, weekday headcount and date overrides.
- Seed: 9 shift templates with required headcount matching the prototype minimums.
- Tests: shifts (5) + rules resolveRequired; all 188+ tests green.

## M4 Planning API and rules - done
- `packages/rules`: `checkEntry` (all SPEC 4.3 codes incl. MINOR_REST), `aggregate` with emergency override, 28 unit tests.
- API: grid (employee/shift views, week/month, coverage, counts, changes, reduced views), validate dry run, entries CRUD with optimistic locking, move/copy/swap/bulk/copy-week, absences (planner), publish with snapshots and notifications, changes/revert/clear-week, substitute finder.
- Seed: published week + draft week + absences + pending vacation request from the prototype patterns.
- Tests: planning (13), absences (9), snapshots (8), grid (8), permission matrix (325 rows) - all green (full API suite ~330 tests).

## M5 Planning UI - done
- `/planning`: employee and shift views, Hotels/Abteilungen multi-selects with counts and search, week navigator, counters, changes panel with revert, copy last week, clear plan dialog, publish, palette + trash, dnd-kit drag and drop with live validation, + menu (templates/absences or searchable employee list with reasons), side panel (edit times, move, substitute finder, reason field, revert, absence removal), reason/emergency dialogs, version-conflict banner, locked past days, print stylesheet.
- Compared screen by screen with `design/prototype.html` via screenshots (employee view, shift view, side panel).
- E2E (Playwright): keyboard path through the + menu, drag template/move/trash, plan -> publish -> remove -> revert: 3 passed.
