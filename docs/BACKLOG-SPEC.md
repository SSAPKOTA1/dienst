# Backlog build (SPEC section 10), built after v1 at the owner's request

Scope: everything in SPEC §10 except **biometrics, employee sick reporting and GPS** (stay excluded). **Wage/hourly-rate fields stay excluded** (owner decision): the payroll export carries hours and hour categories only. SSO, a public API and an installable PWA (instead of native apps) are built as far as feasible without external systems. SPEC.md sections 1-9 remain valid; where this file adds endpoints or rules it extends them. Order of authority is unchanged: SPEC.md, DESIGN.md, db schema, tests, then this file for backlog features.

Milestones: M10 Leave, M11 Hours, M12 Collaboration, M13 Platform. Migrations 005-008, one per milestone.

## M10 Leave
- **Blackout periods** (`absence_blackout`): `GET/POST /blackouts`, `PUT/DELETE /blackouts/:id` (SA, AD, MG of the hotel), `GET /me/blackouts`. `maxConcurrentAbsent = null` means no vacation at all; a number caps simultaneous absences of the employee's department (approved absences of other employees). `department.max_concurrent_absent` is the default cap.
- **Limits are enforced as rules** (`packages/rules/src/leave.ts`, `absenceLimitIssues`): employee requests are blocked (422 `RULE_BLOCKED`, codes `BLACKOUT`, `MAX_CONCURRENT`), planners need a reason (`REASON_REQUIRED`, audited override), the inbox shows `conflicts[]` per request.
- **Half-day vacation**: `halfDay: morning|afternoon` on `POST /schedule/absence` and `POST /me/time-off-requests` (single day, annual leave): counts 0.5, does not cancel the day's entries and does not block planning the other half.
- **Vacation planner** `GET /vacation/overview?year&hotelIds`: per employee entitlement, carryover, taken, planned, requested, remaining, month sums and entries (table and year overview in `/vacation`).
- **Wishes**: employees `POST/GET/DELETE /me/shift-wishes`, `/me/leave-wishes` (priority 1-3); planners `GET /wishes`, `PUT /wishes/shift|leave/:id {decision: grant|decline, note?}`. A pending or granted wish that an entry contradicts yields the warning `WISH_CONFLICT` ("Widerspricht Wunsch"). A wish is never a promise and creates no entry.
- **Vacation notices and carryover**: `POST /vacation/carryover {year}`, `POST /vacation/notices/send {year, kind}`, `GET /vacation/notices`, `GET /me/vacation-notices`, `PUT /me/vacation-notices/:id/ack`. Daily job: carryover 1-7 Jan, expiry of unused carryover on 1 April only for employees who received a notice, notices 1 Oct (initial), 15 Nov (reminder), 1 Dec (final).
- **Month overview** `/month`: read-only range view from `/schedule/grid?range=month`.
