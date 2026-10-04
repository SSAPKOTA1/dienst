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

## M6 Kiosk and live - done
- API: kiosk auth by device token (rate limited per device), roster, search, punch-in (grace, unplanned, idempotent), reason, two-step punch-out with break confirmation, heartbeat, PIN lock, auto-checkout job, `/live` groups and `/live/close-open`.
- Web: `/kiosk` (name cards, search, PIN pad, break screen, results, 30 s idle reset, heartbeat, device-not-registered screen) and `/live` board with "Per Korrektur schließen".
- Tests: kiosk (9 integration tests incl. fake-clock auto-checkout), e2e kiosk flow (5) and planning (3); full suite 344 API tests green.

## M7 Requests, approvals, close - done
- API: `GET /approvals` (worked_time with flags/age/overdue, corrections, absences with remaining -> remainingAfter and under-staffing hint), `PUT` decisions for worked time (approve with paid adjustments / reject), corrections and absences, `POST /approvals/worked-time/bulk-approve`, `GET /approvals/count`, `GET /reports/attendance` (+CSV), `GET /periods`, `POST /periods/close`, `POST /periods/:id/reopen`, `GET /audit-log` (+CSV), employee self-service (`/me/schedule`, `/me/attendance` with visibility rules and history, `/me/vacation`, `/me/time-account`, `/me/corrections`, `/me/time-off-requests`, `/me/home`) and `/notifications`.
- Web: `/requests` (Zeiten prüfen, Abwesenheiten, Stempelkorrekturen, inline paid-time adjustment, bulk approve, "n Tage offen" badge, inbox badge in the nav); admin tabs Tablets (pair with one-time token, lock/unlock, online/offline), Regeln (read-only), Protokoll (filters, CSV), and the month close / reopen panel in Übersicht.
- Tests: approvals.test (17: approve/reject effects, bulk, scope, self-approval, visibility modes, correction types, vacation flow, period close/reopen, report, audit log, notifications), +21 permission-matrix rows; e2e requests (2). Full API suite 471 green, e2e 10 green.

## M8 Exports and portal - done
- API: `GET /schedule/export` (xlsx, grid-based, German labels), `GET /timesheets` and `GET /me/timesheet` (pdf/xlsx, approved only), `GET /me/time-off-requests/preview`; attendance and audit CSV came with M7.
- Web: Handy-Portal at `/me` (mobile-first with bottom tab bar): Start (next shifts, this week, vacation, time account, notifications), Dienstplan, Zeiten (hours hidden until approved, history, corrections), Urlaub (preview, request, withdraw), Konto (time account, timesheet download, profile); "Als Excel exportieren" in the planner; timesheet PDF/Excel in the staff detail.
- Tests: exports (5), request preview, +3 matrix rows; e2e portal (4).

## M9 Import and hardening - done
- API: `GET /employees/import-template`, `POST /employees/import` (dry run, `onDuplicateEmail`), `GET /imports/:id`, `/imports/:id/errors.csv` (formula-injection neutralised), `/imports/:id/credentials.pdf` (once, 24 h); global rate limit, opt-in proxy trust, production config guard.
- Web: `/staff/import` (template, dry run, confirm, error CSV, credentials PDF); kiosk search path fixed to use `punch-status`.
- Tests: import (8), hardening (5), +5 matrix rows; e2e: full flow (plan by drag and drop -> publish -> tablet punch -> approve -> timesheet PDF), import, requests, portal, planning, kiosk.
- README with setup, demo logins, commands and production notes.

## M10 Leave (backlog) - done
- Blackout periods and concurrent-absence caps as rules, half-day vacation, vacation planner (`/vacation`: overview table, year overview, manual entry, blackouts, wishes, notices), employee wishes with `WISH_CONFLICT` warnings, vacation notices and carryover jobs, month overview (`/month`), portal: half days, wishes, notices.
- Tests: leave (8), rules leave (7), +20 matrix rows, e2e leave (2).

## M11 Hours (backlog) - done
- Ledger and comp time, hour categories, payroll export (hours only), rule profiles (stricter only) with Sunday/night/rest-compensation/replacement-rest compliance, feature toggles, analytics; UI: Compliance, Auswertung, editable Regeln, ledger, payroll export.
- Tests: hours (9), rules hours (12), +18 matrix rows, e2e hours (2).

## M12 Collaboration (backlog) - done
- Swaps and giveaways with rule checks and auto-approval option, open shifts, availability and qualification rules, encrypted documents, offboarding with exit statement, announcements with read confirmation, questions to management, hotel feed, ICS subscription, team absences; portal tab Team and planner pages.
- Tests: swaps (8), people (7), comms (6), rules +; matrix rows; e2e collab (4).
