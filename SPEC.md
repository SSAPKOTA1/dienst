# SPEC.md - v1 build specification

Read `CLAUDE.md` first. This file defines exactly what to build. Section numbers are referenced by the milestones in section 9.

## 1. Scope of v1

**Design:** the clickable prototype in `design/` (see `design/DESIGN.md`) is the visual and interaction reference for every screen. SPEC.md defines behaviour, data, rules and API. Where they differ, `design/DESIGN.md` section 4 and this SPEC decide, in that order of the table notes.

**Build:** accounts and roles with role selector and TOTP for admins; automatic employee accounts; companies, hotels, departments, shift templates with required headcount; employees with contracts, personnel numbers, 6-digit PINs and a computed time account; the Dienstplan (employee view + shift view, multi-hotel filters, + menu, drag and drop, draft/published with change panel, substitute finder, copy/clear week, absences, publish); tablet kiosk (name + PIN, break confirmation, grace period, unplanned punches, auto-checkout, heartbeat); Live view; worked-time approval, corrections, vacation requests and approvals, hours-visibility setting; month close; timesheet and schedule exports; employee portal; admin setup (hotels, users, tablets, read-only rules, audit log, onboarding checklist); employee Excel import; seed data from the prototype; tests.

**Not in v1:** see section 10.

**Users:** super admin (SA), admin (AD), manager (MG), employee (EM), and the kiosk device (KIOSK).

## 2. Roles, scope, permissions

### 2.1 Scope resolution
| Role | May touch |
|---|---|
| SA | everything |
| AD | companies in `admin_company`, all their hotels |
| MG | hotels in `manager_hotel` |
| EM | own employee row(s) only |
| KIOSK | the single hotel of the registered `kiosk_device` |

A person has one `user_account`. Every employee gets a `user_account` and the `employee` role automatically at onboarding (4.14). Login returns `availableRoles` (`superAdmin`, `admin`, `manager`, and one `employee` entry per employee row, each with `employeeId` and `companyName`). The user selects one; the access token carries `sub`, `role`, `employeeId?`, `companyIds[]` (AD), `hotelIds[]` (MG or employee). Switching role issues a new token. Permissions never combine across roles.

### 2.2 Permission matrix
| Capability | SA | AD | MG | EM |
|---|---|---|---|---|
| Create companies, hotels, admins | x | | | |
| Managers, departments, kiosk devices, hotel settings, holidays | x | x | | |
| Shift templates and required headcount | x | x | x | |
| Employees and contracts, reset/unlock PIN, import | x | x | | |
| See full employee data (full name, email, DOB, phone) | x | x | | own |
| See employees as display name (first name + last initial) | x | x | x | |
| Plan shifts, mark absences (incl. sick), publish | x | x | x | |
| Approve worked time and corrections | x | x | x | |
| Close / reopen month | x | x | | |
| Audit log | x | x | | |
| Own schedule, hours (per visibility), vacation, corrections | | | | x |

Managers see employees by `display_name` only (home-hotel rule in 4.20). They never see email, DOB, phone, contract details beyond hours targets, or PINs.

### 2.3 Self-approval
A planner may not approve or reject a worked-time record or correction that belongs to their own employee row (error `SELF_APPROVAL`).

## 3. Data model
`db/schema_v1.sql` is authoritative (31 tables). Key facts:
- `employee` = one employment at one company; `employee_hotel` lists hotels (primary included); `employee_department` lists departments. `display_name` is generated.
- `employee_contract` is effective-dated; no overlapping versions (exclusion constraint). Daily target = weekly target / `work_days_per_week`; weekly target = `target_hours_per_week` or `target_hours_per_month * 12 / 52`; both null means no tracking.
- `schedule`: many rows per employee per day allowed; overlap across all hotels blocked by the exclusion constraint (map Postgres error `23P01` to `RULE_BLOCKED` with code `OVERLAP`). `version` is incremented on every update (optimistic locking). `status`: `draft`, `published`, `cancelled`.
- `punch_record`: `actual_punch_in/out` are the legal record and are written once; paid times are `paid_start`, `paid_end`, `actual_break_minutes`, `paid_hours`. One open punch per employee (unique partial index).
- `employee.personnel_number` is generated per company (`P` + next number starting at 100, unique per company); `employee.opening_balance_hours` seeds the time account (4.15).
- `schedule_snapshot` stores each publication of a hotel week (4.18); `user_account.last_login_at` is set on every successful login; `time_off.decided_*` and `decision_note` record request decisions (4.19); `company.pin_length` defaults to 6.
- `time_off` rows carry the absence `type` (FK `absence_type`), `time_off_days`, `credits_hours`, `counts_against_allowance`.
- Columns present but unused in v1: `hotel.break_mode`, `kiosk_identification`, `web_punch_allowed_cidrs`, `allow_web_punch`, `employee.badge_hash`, `phone`, `department.max_concurrent_absent`, `company.swap_approval`, `team_absence_visibility`, `managers_can_see_phone`, `contract.carryover_limit_days`, `account_*`, `punch_record.break_segments`, `source` values `web`/`kiosk_offline`.
- `employee.is_floater` is used in v1 only for the "Springer" badge and the candidate lists.
- Public holidays: seed national, Hesse (`HE`) and Berlin (`BE`) for 2026 and 2027; scope resolution `hotel > company > state > national`; `is_holiday=false` cancels an inherited holiday.

## 4. Rules and algorithms (implement in `packages/rules`, pure and unit-tested)

### 4.1 Reference implementations (must match `tests/vectors.json`)
```ts
// all minute values are integers
export const requiredBreakMinutes = (g: number) =>
  g <= 360 ? 0 : g <= 390 ? g - 360 : g <= 570 ? 30 : 45;      // ArbZG 4, net-time logic
export const paidHours = (g: number, b: number) =>
  Math.round(((g - b) / 60) * 100) / 100;
export const variationMinutes = (actualIso: string, plannedIso: string) =>
  Math.trunc((Date.parse(actualIso) - Date.parse(plannedIso)) / 60000);
export const withinGrace = (v: number, grace = 15) => Math.abs(v) <= grace;
export const restPeriodResult = (gapMin: number) =>
  gapMin < 600 ? 'blocked' : gapMin < 660 ? 'needs_reason' : 'ok';
export const dailyLimitResult = (workMin: number) =>
  workMin > 600 ? 'blocked' : workMin > 480 ? 'warn' : 'ok';
export function proratedVacationDays(annual: number, startIso: string, year: number) {
  const [y, m, d] = startIso.split('-').map(Number);
  if (y < year) return annual;
  if (y > year) return 0;
  if (m < 7 || (m === 7 && d === 1)) return annual;           // waiting period completed in the year
  const fullMonths = d === 1 ? 12 - m + 1 : 12 - m;
  return Math.floor((annual * fullMonths) / 12 + 0.5);        // round half up
}
export const displayName = (f: string, l: string) => `${f} ${l.charAt(0)}.`;
export const openSlots = (required: number, assigned: number) => Math.max(0, required - assigned);
export const usernameBase = (first: string, last: string) => {
  const t = (x: string) => x.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  return `${t(first)}.${t(last)}`;                                  // if a part is empty: 'user' + 6 random digits
};
export const nextUsername = (base: string, taken: Set<string>) => {
  if (!taken.has(base)) return base;
  let n = 2; while (taken.has(base + n)) n++; return base + n;
};
export function timeAccountBalance(p: { opening?: number; monthlyTarget: number; startIso: string; asOfIso: string;
  approvedPaidHours: number; creditHours: number; unpaidDays?: number; dailyTarget?: number }): number {
  const start = new Date(p.startIso + 'T00:00:00Z');
  const end = new Date(p.asOfIso + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() - 1);   // asOf is exclusive
  let target = 0;
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); new Date(Date.UTC(y, m, 1)) <= end; ) {
    const first = new Date(Date.UTC(y, m, 1));
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const last = new Date(Date.UTC(y, m, dim));
    const a = start > first ? start : first, b = end < last ? end : last;
    if (b >= a) target += (p.monthlyTarget * (Math.round((+b - +a) / 86400000) + 1)) / dim;
    m++; if (m > 11) { m = 0; y++; }
  }
  target -= (p.dailyTarget ?? 0) * (p.unpaidDays ?? 0);
  return Math.round(((p.opening ?? 0) + p.approvedPaidHours + p.creditHours - target) * 100) / 100;
}
```
`tests/reference-rules.mjs` contains the same code in JS; unit tests must load `tests/vectors.json` and assert every row.

### 4.2 Time handling
- Hotel-local date of a timestamp = date in `hotel.timezone`. `shift_date` = local date of `planned_start`.
- Working minutes of a planned entry = (`planned_end` - `planned_start`) - `planned_break_minutes`. `planned_break_minutes` defaults to `requiredBreakMinutes(gross)` unless the planner sets it.
- Week = ISO week Monday-Sunday by `shift_date`. Month = calendar month by `shift_date`.

### 4.3 Planning rule checks (employee-level, across all hotels)
Each check returns `{code, severity: 'block'|'needs_reason'|'warn', message, details}`.

| Code | Condition | Severity |
|---|---|---|
| `OVERLAP` | entry overlaps another non-cancelled entry of the employee | block |
| `PAST_DAY` | `shift_date` before today (hotel-local) for a work shift | block |
| `PERIOD_CLOSED` | date inside a closed payroll period | block |
| `NOT_AT_HOTEL` | employee not in `employee_hotel` for the hotel | block |
| `WRONG_DEPARTMENT` | shift department not in `employee_department` | block |
| `ABSENCE_CONFLICT` | employee has approved/planned absence that day | block |
| `CONTRACT_INACTIVE` | no contract valid on the date, or employee inactive | block |
| `DAILY_LIMIT` | working minutes that local day (all entries) > 600 | block, `emergencyOverride` by AD/SA with reason |
| `DAILY_OVER_8H` | working minutes that day > 480 | warn |
| `REST_PERIOD` | gap to previous/next entry < 660 min: `needs_reason` if >= 600, else block (`emergencyOverride` allowed for AD/SA) | see left |
| `MINOR_NIGHT` | employee under 18 on `shift_date` and entry overlaps 20:00-06:00 local | block |
| `MINOR_DAILY` | employee under 18 and working minutes that day > 480 | block |
| `MINOR_REST` | employee under 18 and gap to a neighbouring entry < 720 min | block, `emergencyOverride` by AD/SA with reason |
| `MONTHLY_CAP` | contract `monthly_hours_cap` set and planned hours in the month exceed it | warn |
| `VACATION_EXCEEDS` | planned annual leave days exceed remaining allowance | needs_reason |

Aggregate: `blocked` if any block; else `needs_reason` if any needs_reason (the caller must send `overrideReason`, 5-300 chars); else `ok` (warnings listed). With `emergencyOverride: true` (role AD or SA, `overrideReason` required) the codes `DAILY_LIMIT`, `MINOR_REST` and `REST_PERIOD` (when < 600) are downgraded to `needs_reason`; everything else stays blocked. Every override is audit-logged with rule code and reason.

### 4.4 Absences (planner action)
`POST /schedule/absence` creates one `time_off` row per contiguous range.
- Counted days: dates in the range that fall on the employee's `working_weekdays` and are not public holidays at the hotel. Half days are out of scope in v1.
- Effects: overlapping `schedule` rows get `status='cancelled'`, `cancel_reason` = `sick` or `changed`, `time_off_id` set; `annual_leave` increases `used_days` in `employee_vacation_allowance` (create the row for the year on first use using `proratedVacationDays` and the contract); removing the absence reverses this.
- Types in the + menu: `sick_leave`, `off_day` (Free day), `annual_leave` (Vacation), `unpaid_leave` (Unpaid day off), `vocational_school` (Berufsschule, counts as working time); the other `absence_type` rows stay hidden in v1.
- Past days: only `sick_leave`. Managers may go back `company.sick_backdate_days` (7) days from today; AD/SA any date with a reason. Closed period: blocked. If a non-rejected `punch_record` exists on a day: blocked with `PUNCH_EXISTS`.
- Vacation: if `used + new days > allocated`, return `VACATION_EXCEEDS` (needs_reason).

### 4.5 Punch processing (kiosk)
1. Match schedule: the employee's non-cancelled, published entry at the kiosk's hotel with `planned_start - 3h <= now <= planned_end + 3h`; choose the smallest `|now - planned_start|`. None found means `is_unplanned = true`.
2. Clock-in: `actual_punch_in = now()` (server time). `shift_date` = local date of `planned_start` (or of now if unplanned). Variation = `variationMinutes(now, planned_start)`. Within grace: `paid_start = planned_start`. Outside grace: `paid_start = actual_punch_in` and a `time_variation` row (`clock_in_early`/`clock_in_late`, status `pending`). Unplanned: `paid_start = actual_punch_in` and a `time_variation` of type `unplanned`.
3. Clock-out step 1 captures `outAt = now()` inside the signed `confirmToken` (5 min) and returns gross minutes, `requiredBreakMinutes`, and break options `[0,15,30,45,60]` plus the required value. The record stays open.
4. Clock-out step 2 sets `actual_punch_out = token.outAt`, `actual_break_minutes`, computes the same grace logic for the end (`clock_out_early`/`clock_out_late`), `paid_end`, `paid_hours = paidHours(paid_end - paid_start in minutes, actual_break)`. If `actual_break < required`: `under_break_warning = true` and a `reason` is required (422 `REASON_REQUIRED`). If the employee never provides one, the request is rejected.
5. Approval status after step 2: `pending` if any of: variation outside grace, unplanned, under-break, auto-checkout, correction; otherwise `approved` with `approval_source='auto'`.
6. A second clock-in within 60 s of the last returns the same record (idempotent). Clock-in while a record is open returns 409 `ALREADY_CLOCKED_IN`.
7. PIN: 5 wrong attempts set `pin_locked_until = now + 15 min` (response 423 `PIN_LOCKED`); success resets the counter. Verification only after the employee was selected (`employeeRef`).
8. Auto-checkout job (every minute, injectable clock): open record with a schedule and `now > planned_end + 60 min` -> `actual_punch_out = planned_end`, `actual_break_minutes = requiredBreakMinutes(gross)`, `auto_checked_out = true`, status `pending`, notify the hotel's managers and the employee. Unplanned open record older than 12 h -> `actual_punch_out = actual_punch_in + 8h`, same flags.

### 4.6 Approval decisions
`PUT /approvals/worked-time/:id` with `decision`:
- `approve` (optional `paidStart`, `paidEnd`, `breakMinutes`): updates paid fields (actual punch times are never changed), recomputes `paid_hours`, approves all pending variations of the record, writes `punch_record_history`.
- `reject`: `paid_start/paid_end` = planned times (unplanned: `paid_hours = 0`), `actual_break_minutes = requiredBreakMinutes(planned gross)`, variations rejected.
Both set `approved_by_*`, `approved_at`, notes, notify the employee.

### 4.7 Corrections
Employee requests (`missed_in`, `missed_out`, `wrong_time`, `missing_day`) with a reason. On approval: `missed_*`/`missing_day` insert or complete a `punch_record` with `source='correction'` (times as requested, status approved by the decider); `wrong_time` updates only paid fields of the referenced record. Always write history. Blocked in closed periods.

### 4.8 Hours visibility
Per hotel `employee_hours_visibility`. Employee attendance endpoints: if `after_approval` and the record is not approved, return `{date, status, hoursHidden: true}` without times or hours (rejected records include the decider's note). Weekly/monthly totals count approved records only, in both modes. With `immediately`, pending records show times and hours with `preliminary: true`.

### 4.9 Planning grid totals
- Employee view: per employee, sum of working minutes of non-cancelled entries in the range (hours with one decimal) vs target (weekly range: weekly target; month range: monthly target = `target_hours_per_month` or weekly x 52/12). For salary workers also `creditHours` = daily target x number of credited absence days (`credits_hours` types) in the range.
- Shift view: per shift row, total hours of assigned entries; per cell `required` (date override, else weekday default, else 0), `assigned` count, `open = openSlots`.
- Totals come from the server only.

### 4.10 Publishing
Entries start as `draft`. `POST /schedule/publish {hotelIds, from, to}` sets `published`, `published_at`, writes snapshots (4.18); response includes `changedCount` and `openSlots`. A change to a published entry keeps it published and creates a `schedule_changed` notification; employees see published entries only.

### 4.11 Month close
`POST /periods/close {companyId, hotelId?, from, to}` fails with 409 `PENDING_APPROVALS` (list included) if worked-time approvals or corrections are pending in the range. After closing, any write that affects a local date in the range fails with 409 `PERIOD_CLOSED` (planning, punches/approvals/corrections, absences). `POST /periods/:id/reopen` (AD/SA, reason required) sets it open again. Both audit-logged.

### 4.12 PIN generation
Random digits of `company.pin_length` (default 6), rejecting all-equal and straight ascending/descending sequences, hashed with argon2id. Returned once in the create/reset response only.

### 4.14 Employee accounts (automatic)
Onboarding (single create and import) always links a login, in the same transaction as the employee row:
1. If `email` is given and a `user_account` with that email (case-insensitive) exists: reuse it, send no invitation; the person gets an additional employee role entry. If that account already has an `employee` row in the same company: 409 `DUPLICATE_EMPLOYEE`.
2. Otherwise create a `user_account`: `email` (may be null), `username = nextUsername(usernameBase(first,last), takenUsernames)`, `status = 'pending_invite'`, no password.
3. `employee.status = 'active'` immediately: kiosk punching works before the web account is activated. Account activation concerns web login only.
4. Activation: with email, an invitation mail with a link (token valid 24 h). Without email, a one-time activation code (10 characters, uppercase letters and digits without 0, O, 1, I; valid 7 days) is returned once in the create response and printed on the slip together with the username and the PIN; the employee activates at `/accept-invitation` with username + code + new password. Store only hashes in `invitation_token_hash`.
5. Login identifier is email or username (case-insensitive). Password reset by mail for accounts with email; without email an admin issues a new code (`POST /employees/:id/reset-activation`).
6. Deactivating an employee sets `employee.status = 'inactive'`; the `user_account` is set to `disabled` only if it has no other active role or employment, otherwise the account stays and the employee entry disappears from `availableRoles`.
7. The role selector at the next login lists the new employee role automatically.

### 4.13 Onboarding calculations
Allocated vacation for the current year = request override, else `proratedVacationDays(contract.vacation_days_per_year, contract_start_date, year)`; `used` = request value or 0.

### 4.15 Time account (computed, read-only)
Only for employees whose contract has `working_model = 'salary'` and a weekly or monthly target; otherwise the value is `null` and the UI hides it.
```
balance(asOf) = opening_balance_hours
              + sum(paid_hours of APPROVED punch records with local shift_date in [contractStart, asOf-1])
              + creditHours
              - targetHours
creditHours   = dailyTarget x counted absence days of types with credits_hours (annual_leave, sick_leave, special_leave,
                training, vocational_school, public_holiday)   // 4.4 day counting; public holidays on working weekdays without a punch
targetHours   = sum over calendar months of monthlyTarget x coveredDays / daysInMonth
                - dailyTarget x counted absence days of types with reduces_target (unpaid_leave, child_sick, parental_leave, maternity_leave)
monthlyTarget = target_hours_per_month, or target_hours_per_week x 52 / 12
```
`coveredDays` = days of that month inside [max(contractStart, month start), min(asOf-1, month end)]. Round to 2 decimals. Reference `timeAccountBalance` is in `tests/reference-rules.mjs`; vectors in `tests/vectors.json` (`timeAccount`). Endpoints: `GET /employees/:id/time-account` (AD, SA, MG of the home hotel) and `GET /me/time-account`.

### 4.16 Live attendance
`GET /live?hotelIds=` returns `{serverTime, groups}` for the hotel-local today:
- `clockedIn`: open punch records `{employeeId, displayName, departmentName, since, plannedEnd, flags[]}`.
- `expectedNotIn`: published entries with `planned_start + 10 min <= now < planned_end`, no punch for the entry, less than 60 min late.
- `noShow`: published entries with no punch and `now >= planned_start + 60 min`.
- `needsReview`: open records with `now > planned_end + 60 min` (before the auto-checkout job closes them) or unplanned records open longer than 10 h; each carries a short reason.
`POST /live/close-open {punchRecordId, outAt, breakMinutes, reason}` (planners) closes an open record as a correction: `source='correction'`, approved by the planner, history entry, audit; blocked in closed periods and for the planner's own record.

### 4.17 Substitute finder
`GET /schedule/candidates?hotelIds=&departmentId=&date=&shiftId=` (or `start`/`end`): active employees who belong to the hotels and the department; run the 4.3 checks for a hypothetical entry; exclude anyone with a `block`; return `{employeeId, displayName, hotelName, isFloater, weekHours, targetHours, warnings[]}` sorted by number of warnings ascending, then planned hours of that ISO week ascending. Nobody is notified automatically.

### 4.18 Draft vs published changes
- `POST /schedule/publish` writes one `schedule_snapshot` per hotel and week (all non-cancelled entries, with ids) and sets the entries to `published`.
- Changes are computed against the latest snapshot of that hotel and week, keyed by entry id: `new` (id not in the snapshot), `changed` (start, end, break, employee or date differ), `removed` (in the snapshot but now deleted or cancelled). A week never published has no snapshot: every entry is `new`.
- Deleting a published entry sets `status='cancelled'`, `cancel_reason='changed'` so it shows as `removed` until the next publish; deleting a draft deletes the row.
- Grid entries carry `change: null|'new'|'changed'|'removed'`; the response has `changes[]` and `counts {drafts, warnings, underStaffed}`.
- `POST /schedule/revert {hotelIds, from, to, entryId?}` restores the snapshot state (delete new, un-cancel removed, reset changed fields); with `entryId` it reverts one entry. Not allowed for past days.
- `POST /schedule/clear-week {hotelIds, from, to}` removes drafts and cancels published entries for today and future days only (absences and past days stay); returns `{deleted, cancelledPublished}`.
- Notifications on publish: employees with a `new` only entry get `schedule_published`; employees with any `changed` or `removed` entry get `schedule_changed`.

### 4.19 Vacation requests (employee)
- `POST /me/time-off-requests {from, to, reason?}` (type `annual_leave` only, no half days in v1): counted days per 4.4; if `remaining < days` return 422 `INSUFFICIENT_VACATION` (`details.remaining`); otherwise create `time_off` with `status='pending'` and `created_by_user_id` = the employee's user; notify the managers of the home hotel.
- Pending requests show as hatched chips in the grid. The inbox item shows `remaining -> remaining after` and an under-staffing hint (any department/day whose requirement would be missed).
- `PUT /approvals/absences/:id {decision: 'approve'|'reject', note?}`: approve sets `approved`, increases `used_days`, cancels overlapping schedule entries like a planner absence (`cancel_reason='changed'`), notifies; reject sets `rejected` with `decision_note`, notifies. Blocked in closed periods and for the planner's own request.
- `DELETE /me/time-off-requests/:id`: employee cancels a pending or future approved request (`status='cancelled'`, allowance restored, planners notified if it was approved).

### 4.20 Minors and home-hotel visibility
- `MINOR_REST`: gap to the neighbouring entry below 720 min (12 h) for an employee under 18 is `block`; AD/SA may use `emergencyOverride` with a reason (audit-logged).
- Home hotel (Stammhaus): the hotel in `employee.primary_hotel_id`. SA and AD see everything. A manager whose `manager_hotel` contains the home hotel gets the full manager view (display name, personnel number, working days, weekly target, vacation, time account, absence types). A manager of any other hotel gets the reduced view: display name, home hotel, department, planned entries, and absences shown only as `absent` without type. Contact data and date of birth are admin/super admin only for everyone.

## 5. API contract

Base `/api/v1`. Auth: `Authorization: Bearer <accessToken>` (15 min); refresh token in httpOnly cookie `rt` (30 days, rotating). Kiosk: header `X-Kiosk-Token`. Roles in tables: SA, AD, MG, EM, KIOSK, ANY (authenticated), PUBLIC.

### 5.1 Conventions
- Lists: `?page=1&pageSize=50` -> `{items, page, pageSize, total}`.
- Error body: `{ "error": { "code": "RULE_BLOCKED", "message": "...", "details": {} } }`.
- Codes and HTTP status: `VALIDATION` 400, `UNAUTHENTICATED` 401, `DEVICE_INVALID` 401, `PIN_INVALID` 401 (`details.remainingAttempts`), `FORBIDDEN_SCOPE` 403, `SELF_APPROVAL` 403, `NOT_FOUND` 404, `ALREADY_CLOCKED_IN` 409, `PUNCH_EXISTS` 409, `PERIOD_CLOSED` 409, `PENDING_APPROVALS` 409, `VERSION_CONFLICT` 409, `RULE_BLOCKED` 422 (`details.violations[]`), `REASON_REQUIRED` 422, `PIN_LOCKED` 423, `RATE_LIMITED` 429.
- Rule violation item: `{code, severity, message, details}`.
- Writes that change a schedule entry carry the entry's `version`; stale version returns `VERSION_CONFLICT`.
- Rate limits: auth endpoints 10/min/IP; kiosk 60/min/device.

### 5.2 Auth
| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | /auth/login | PUBLIC | `{login,password,totp?}` where `login` is email or username -> `{availableRoles[], accessToken?}`; token returned directly when only one role. AD/SA with TOTP enabled must send `totp`. |
| POST | /auth/select-role | ANY (pre-role token) | `{role, employeeId?}` -> `{accessToken}` |
| POST | /auth/switch-role | ANY | same body, new token |
| POST | /auth/refresh, /auth/logout | ANY | rotate / revoke refresh token |
| POST | /auth/accept-invitation | PUBLIC | `{token,password}` (mail link) or `{username,code,password}` (printed activation code); also used for password reset |
| POST | /auth/forgot-password | PUBLIC | always 204; sends reset mail (1 h token) |
| POST | /auth/2fa/setup, /auth/2fa/verify | AD, SA | TOTP secret + QR; mandatory before first admin use |

### 5.3 Organisation
| Method | Path | Roles | Notes |
|---|---|---|---|
| POST, GET, PUT | /companies | SA (GET: AD own) | name, graceMinutes, sickBackdateDays, pinLength |
| POST, GET, PUT | /hotels | SA create/update; AD, MG read in scope | name, city, federalState, timezone |
| GET, PUT | /hotels/:id/settings | AD, SA (GET also MG) | `employeeHoursVisibility` |
| POST, GET | /admins ; PUT /admins/:id/companies | SA | creates user + invitation |
| POST, GET, PUT | /managers ; PUT /managers/:id/hotels | SA, AD | `hotelIds[]` |
| POST, GET, PUT, DELETE | /departments | SA, AD (GET: MG) | hotelId, name, color |
| POST, GET, PUT, DELETE | /shifts | SA, AD, MG | hotelId, departmentId, name, startTime, endTime, breakMinutes |
| PUT, GET | /shifts/:id/staffing | SA, AD, MG | `{weekdayDefaults:{"1":3,...}, overrides:[{date,count}]}` |
| POST, GET, DELETE | /kiosk-devices | AD, SA | POST returns `token` once |
| GET | /holidays?hotelId&year | ANY in scope | resolved list |
| POST, DELETE | /holidays | AD, SA | company/hotel scope add or cancel |

### 5.4 Employees
| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | /employees | AD, SA | body below; response `{employeeId, userId, username, pin, activation:{method:'email'|'code'|'existing_account', code?, expiresAt?}}`; `pin` and `code` are shown once |
| GET | /employees | AD, SA full; MG display only | filters: hotelId, departmentId, status, q |
| GET, PUT | /employees/:id | AD, SA | |
| GET | /employees/:id/contracts ; PUT /employees/:id/contract | AD, SA | PUT creates a new version with `validFrom` |
| POST | /employees/:id/reset-pin, /unlock-pin | AD, SA | reset returns `pin` once |
| POST | /employees/:id/resend-invitation, /reset-activation | AD, SA | resend mail; or new one-time code (no-email accounts), returned once |
| POST | /employees/:id/deactivate | AD, SA | sets inactive, invalidates PIN and login |
| GET | /employees/import-template | AD, SA | xlsx |
| POST | /employees/import | AD, SA | multipart `file`, `dryRun`, `onDuplicateEmail=skip|update|conflict`; max 10 MB, 5000 rows |
| GET | /imports/:id, /imports/:id/errors.csv | AD, SA | |
| GET | /imports/:id/credentials.pdf | AD, SA | slip sheet with name, username, activation code (if any) and PIN per imported employee; downloadable once within 24 h, plaintext is not stored afterwards |

Create body: `firstName, lastName, dateOfBirth, email?, primaryHotelId, primaryDepartmentId, hotelIds?[], departmentIds?[], contractStartDate, contractEndDate?, employmentType (full_time|part_time|minijob|werkstudent|apprentice|short_term|other), workingModel (hourly|salary), workDaysPerWeek, workingWeekdays?[], targetHoursPerWeek?, targetHoursPerMonth?, vacationDaysPerYear, vacationDaysAllocatedThisYear?, vacationDaysUsedThisYear?, monthlyHoursCap?, getsPublicHoliday?`. The account is always created or linked automatically (4.14); with `email` an invitation mail is sent, without it the response carries the username and a one-time activation code.

Excel columns (row 1 header, same names): the create-body fields in that order, `email` may be empty; arrays as comma lists; dates `YYYY-MM-DD`. Neutralise formula injection in the error CSV (prefix cells starting with `= + - @` with `'`). Reject `.xlsm`.

### 5.5 Schedule (planning calendar)
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | /schedule/grid | AD, SA, MG | `hotelIds` (comma list), `departmentIds?`, `view=employee|shift`, `range=week|month`, `from` |
| POST | /schedule/validate | AD, SA, MG | dry run, nothing saved |
| POST | /schedule/entries | AD, SA, MG | create entry |
| PUT, DELETE | /schedule/entries/:id | AD, SA, MG | PUT needs `version` |
| POST | /schedule/move, /schedule/copy, /schedule/swap | AD, SA, MG | atomic |
| POST | /schedule/copy-week | AD, SA, MG | `{hotelIds, departmentIds?, fromWeek, toWeek}` copies entries as drafts, skipping blocked ones and returning them |
| POST | /schedule/bulk | AD, SA, MG | `{operations[]}` all-or-nothing |
| POST | /schedule/absence | AD, SA, MG | `{employeeId, from, to, type, reason?, certificateStatus?}` |
| DELETE | /schedule/absence/:id | AD, SA, MG | reverses allowance |
| POST | /schedule/publish | AD, SA, MG | `{hotelIds, from, to}` |
| GET | /schedule/export | AD, SA, MG | `format=xlsx`, same filters as grid (the PDF is the browser print view) |

Entry body: `{hotelId, employeeId, shiftId?, date, start?, end?, plannedBreakMinutes?, overrideReason?, emergencyOverride?}` (`start`/`end` local `HH:mm` when no `shiftId`; an end before start means the next day).
Validate body: `{operation: "create"|"update"|"move"|"copy"|"swap"|"delete"|"absence", ...same fields as that operation}` -> `{status: "ok"|"needs_reason"|"blocked", violations[], totals}` where `totals` are the affected rows' new totals.
Move body: `{entryId, version, toEmployeeId?, toDate?, toShiftId?, overrideReason?}`; copy is the same without `version`; swap `{entryAId, versionA, entryBId, versionB}`.

Grid response:
```json
{ "hotelId": 1, "view": "shift", "range": "week", "from": "2026-10-12", "to": "2026-10-18", "status": "draft",
  "days": [{"date":"2026-10-12","holiday":null}],
  "rows": [{ "key": "shift:7", "label": "Early 06:00-14:00", "totalHours": 64.0, "openSlots": 1,
    "cells": [{ "date": "2026-10-12", "required": 3, "assigned": 2,
      "entries": [{ "id": 101, "version": 3, "employeeId": 12, "displayName": "Maria S.", "start": "2026-10-12T06:00:00+02:00",
                    "end": "2026-10-12T14:00:00+02:00", "hours": 7.5, "status": "draft", "warnings": [] }] }] }],
  "absences": [{ "id": 9, "employeeId": 15, "displayName": "Sam T.", "type": "annual_leave", "from": "2026-10-12", "to": "2026-10-16" }],
  "totals": { "perDay": [{"date":"2026-10-12","hours":120.5,"headcount":14}] } }
```
In employee view, rows are employees (`key: "emp:12"`, with `targetHours`, `creditHours`, `totalHours`) and cells hold entries and absences for that employee.

### 5.6 Kiosk (auth: `X-Kiosk-Token`)
| Method | Path | Notes |
|---|---|---|
| GET | /kiosk/roster | entries `{employeeRef, displayName, departmentName, plannedStart, plannedEnd, state: not_in|working|done}`: published shifts starting within +2 h or ended within -2 h, plus everyone currently clocked in |
| GET | /kiosk/search?q= | min 2 chars, max 5 results, display names only |
| POST | /kiosk/punch-in | `{employeeRef, pin}` -> `{punchRecordId, clockedInAt, variation:{minutes,withinGrace}, reasonRequired, confirmToken}` |
| POST | /kiosk/punch/reason | `{confirmToken, reason}` for an out-of-grace clock-in |
| POST | /kiosk/punch-out | `{employeeRef, pin}` -> `{status:"awaiting_break_confirmation", confirmToken, grossMinutes, requiredBreakMinutes, options[]}` |
| POST | /kiosk/punch-out/confirm-break | `{confirmToken, actualBreakMinutes, reason?}` -> `{status:"clocked_out"|"clocked_out_with_warning", paidHours, approvalStatus}` |
| GET | /kiosk/punch-status?employeeRef= | `{state, lastPunchAt}` |

`employeeRef` is a JWT (5 min) bound to device and employee, issued in roster/search results.

### 5.7 Approvals, reports, periods
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | /approvals | AD, SA, MG | `hotelId, type=worked_time|correction|absence, status=pending|approved|rejected, from, to`; items carry `flags[]` (`variation`, `unplanned`, `auto_checkout`, `under_break`, `correction`) |
| PUT | /approvals/worked-time/:id | AD, SA, MG | see 4.6 |
| POST | /approvals/worked-time/bulk-approve | AD, SA, MG | `{ids[]}`; only unflagged records; others returned as failures |
| PUT | /approvals/corrections/:id | AD, SA, MG | `{decision, notes?}` |
| GET | /reports/attendance | AD, SA, MG | `hotelId, from, to, flag?, employeeId?` -> rows; `?format=csv` downloads (UTF-8 BOM, `;` separator) |
| GET | /timesheets | AD, SA, MG | `employeeId, month=YYYY-MM, format=pdf|xlsx` |
| GET | /periods | AD, SA | |
| POST | /periods/close ; POST /periods/:id/reopen | AD, SA | see 4.11 |
| GET | /audit-log | AD, SA | filters: actor, action, entity, from, to |

### 5.8 Employee self-service and notifications
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | /me | EM, MG, AD, SA | profile (employee sees contract summary read-only) |
| GET | /me/schedule?from&to | EM | published entries and own absences |
| GET | /me/attendance?from&to | EM | visibility rules 4.8; `/me/attendance/:id/history` shows who changed what |
| GET | /me/vacation | EM | `{allocated, used, remaining}` |
| POST, GET | /me/corrections | EM | |
| GET | /me/timesheet?month&format=pdf | EM | only approved records |
| GET | /notifications ; PUT /notifications/:id/read | ANY | |
| GET | /health | PUBLIC | |

Employees cannot report sickness in the app. There is no sick request endpoint.

### 5.9 Endpoints added from the design
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | /schedule/changes | AD, SA, MG | `hotelIds, from, to` -> `changes[]` (4.18) |
| POST | /schedule/revert | AD, SA, MG | 4.18 |
| POST | /schedule/clear-week | AD, SA, MG | 4.18 |
| GET | /schedule/candidates | AD, SA, MG | 4.17 |
| GET | /live | AD, SA, MG | 4.16 |
| POST | /live/close-open | AD, SA, MG | 4.16 |
| GET | /employees/:id/time-account ; GET /me/time-account | AD, SA, MG (home hotel); EM | 4.15 |
| POST, GET | /me/time-off-requests ; DELETE /me/time-off-requests/:id | EM | 4.19 |
| PUT | /approvals/absences/:id | AD, SA, MG | 4.19; `GET /approvals?type=absence` lists them |
| GET | /me/home | EM | `{today, nextShifts[], weekHours, weekPlannedHours, targetHours, vacation, timeAccount, notifications[]}` |
| GET | /users | AD, SA | `{userId, name, login, roles[{role, hotelNames[]}], lastLoginAt, status}`; role and hotel changes use `/managers`, `/admins` |
| GET | /setup/status ; POST /setup/rules-viewed | AD, SA | onboarding checklist: `hotelsDepartments`, `employees`, `invitations` (count never logged in), `tablet`, `rules` (done after `rules-viewed`), `firstPublish` |
| PUT | /kiosk-devices/:id | AD, SA | `{status: active|revoked, name?}`; GET returns `online` (last heartbeat under 3 min) |
| POST | /kiosk/heartbeat | KIOSK | updates `last_seen_at`, sent every minute |
| GET | /audit-log?format=csv | AD, SA | UTF-8 BOM, `;` separator |

Changes to earlier tables: `GET /schedule/grid` and `/schedule/export` take `hotelIds` (comma list) and `departmentIds` instead of `hotelId`/`departmentId`; entries of employees whose home hotel is outside the caller's hotels carry `homeHotel` and `isOtherHotel: true`; `GET /employees` returns `personnelNumber`; the create response includes `personnelNumber`; the grid response adds `changes`, `counts`, and `coverage` (per department and day: `assigned`, `required`, `underStaffed`).

## 6. UI specification

**The prototype in `design/` is the visual and interaction reference** (open `design/prototype.html`; read `design/DESIGN.md` first). Build with React + Tailwind using `design/tokens.css`, Archivo, radius 0, German default language with an English switch, strings seeded from `design/i18n-de-en.json`. `design/DESIGN.md` section 4 lists, per screen, what to build, what is v2 and where the SPEC overrides the prototype. Never colour alone; keyboard operable.

### 6.1 Routes and navigation
Top navigation sections as in `design/DESIGN.md` section 3 (Planung > Dienstplan; Heute > Live, Anträge; Team > Mitarbeiter; Admin > Einrichtung). Routes:
| Route | Role | Screen |
|---|---|---|
| /login, /accept-invitation, /forgot-password | public | login ("E-Mail oder Benutzername"), TOTP step, role selector, activation by link or username + code |
| /planning | AD, SA, MG | Dienstplan (6.2) |
| /live | AD, SA, MG | Live (4.16) |
| /requests | AD, SA, MG | Anträge: groups "Zeiten prüfen", "Abwesenheiten" (vacation), "Stempelkorrekturen" |
| /staff, /staff/new, /staff/:id, /staff/import | AD, SA (MG reduced list/detail per 4.20) | Mitarbeiter: list, create stepper, detail, Excel import |
| /admin/overview, /admin/hotels, /admin/users, /admin/tablets, /admin/rules, /admin/audit | AD, SA | Einrichtung tabs; Regeln read-only; month close lives under Hotels or Übersicht as "Monat abschließen" |
| /admin/companies | SA | companies, hotels, admins |
| /me | EM | Handy-Portal: Home, schedule, attendance, vacation requests, corrections, time account, timesheet download |
| /kiosk | KIOSK | Tablet (6.3) |

### 6.2 Dienstplan
Follow the prototype layout: toolbar with Hotels and Abteilungen multi-select dropdowns (counts, search, select all), segmented control "Nach Mitarbeiter | Nach Dienst", week navigator with KW label and week-state chip, counters for Entwürfe, Warnungen, Unterbesetzt, the changes panel, "Vorwoche kopieren", "Plan leeren", "Dienstplan als PDF" (browser print with print stylesheet), publish button "N Entwürfe veröffentlichen". Sticky header and first column; right-hand "Woche gesamt / Soll" column; coverage row "Besetzung · min." per department and day.
- Employee view cells hold chips (split shift = two chips); shift view cells list employee chips with `assigned/required` and dashed open slots; absences shown as chips with text (Urlaub, Berufsschule, Krank, Frei) plus hatched pending vacation requests.
- Interactions (all backed by the server, SPEC 4.3 and 5.5): hover an empty cell shows `+` with a menu anchored to the button (employee view: shift templates, then Sick leave, Free day, Vacation, Unpaid day off, Berufsschule; shift view: searchable employee list, unavailable ones greyed with the reason); selecting an entry opens the side panel (assign, save, remove, reason field, "Vertretung finden") and shows the cut icon that deletes it; drag chips between cells in both views (validate while dragging, green/amber/red target, Alt = copy, drop on chip = swap), drag templates from "Schicht ziehen", drag to the delete zone; range select across days; reason popover for `needs_reason`; `VERSION_CONFLICT` banner and refetch.
- Locked cells: past days (only Sick leave allowed) and closed periods, with the lock label "Vergangen · gesperrt".
- Warning chips: Ruhezeit, Jugendarbeitsschutz, Unterbesetzt from server results. Minors show a badge; floaters show "Springer".
- Week range only in v1.

### 6.3 Tablet (kiosk)
Follow the prototype (name cards, "Nicht dabei? Namen suchen", PIN pad, remaining attempts, result screen, server time) with these SPEC changes: 6-digit PIN by default; clock-out shows one break screen (planned/required break pre-selected, one tap to confirm, options 0/15/30/45/60, reason field when shorter than required); unplanned punch notice; offline banner is out of scope (offline kiosk is backlog); device-not-registered screen; `POST /kiosk/heartbeat` every minute; auto-reset after 30 s idle.

### 6.4 Other screens
- Anträge: rows with display name, what, detail, warning hint, Genehmigen / Ablehnen with note; "Zeiten prüfen" rows add flags, planned vs actual, inline paid-time adjustment and bulk approve for unflagged records; badge on records older than 5 days.
- Mitarbeiter, Einrichtung and Handy-Portal as in `design/DESIGN.md` 4.4, 4.5, 4.7. After creating an employee show the result panel with personnel number, PIN, username and activation code (once) and a Print slip button.
- Handy-Portal: mobile-first; no sick button; "waiting for approval" state when hours are hidden.

## 7. Seed data (`pnpm db:seed`)
Use `design/sample-data.json` so the UI matches the prototype.
- Company "Trip Inn Hotels"; hotels Frankfurt (`HE`, 9 employees) and Berlin (`BE`, 6 employees); departments Rezeption, Housekeeping, Frühstück per hotel.
- Shift templates from the sample (Früh 06-14, Spät 14-22, Nacht 22-06 for Rezeption; Tag 08-16:30 for Housekeeping; Frühstück 06-11), planned break 30 minutes where the shift is longer than 6 h 30. Required headcount defaults so the coverage row equals the prototype minimums (Rezeption 3 per day over Früh/Spät/Nacht, Housekeeping 3, Frühstück 1).
- The 15 employees of the sample with their weekly target, kind, working weekdays, personnel number, birth date, vacation entitlement, opening balance (their sample time account), carryover, `minor` (derived from birth date, Lena Hofmann is 17) and `floating` (`is_floater`). Aylin Demir works at several hotels. No wage fields.
- Users (dev password `Demo!2345`, status active): `sa@demo.test`, `admin@demo.test` (Anna Krüger, regional lead, admin of the company), `manager@demo.test` (manager of Frankfurt), `maria.garcia` and the other employees as usernames or emails; one employee without email (username + activation code). Print every username, PIN and the kiosk device token once.
- Holidays 2026-2027 national + HE + BE; absence types; one published week and one draft week around the seed date with the situations in the prototype (rest-period warning, minor rest violation, an under-staffed day, an approved vacation range, a Berufsschule day, a sick day); a pending vacation request, a pending correction (missing clock-out) and one open punch with no clock-out so the Live view has content.

## 8. Required tests
- **Unit (`packages/rules`):** every row of `tests/vectors.json`.
- **Integration (real Postgres):**
  - permission matrix table-driven: each endpoint x role returns 200/403 as in 2.2;
  - tenant isolation: AD of company A cannot read or write company B; MG cannot read another hotel;
  - planning: overlap across hotels, split shifts allowed, rest period outcomes, daily limit and emergency override, minor rules, past-day block, absence conflict, department/hotel membership, optimistic locking 409, publish notifications, headcount and totals;
  - absences: sick backdate limit for MG vs AD, vacation allowance, `PUNCH_EXISTS`, reversal;
  - kiosk: invalid device, PIN lock after 5 failures, two-step clock-out, under-break reason, unplanned punch, idempotent double clock-in, auto-checkout with a fake clock;
  - approvals: approve/reject effects, self-approval blocked, hours visibility modes, correction types;
  - month close: pending approvals block, closed period blocks writes, reopen;
  - design behaviours: change tracking against snapshots (new/changed/removed, revert, clear-week), candidate ordering, Live groups and `close-open`, home-hotel reduced view, `MINOR_REST`, vacation request flow (insufficient balance, approve, reject, cancel), time account vectors, personnel number uniqueness, kiosk heartbeat and online status;
  - employee accounts: onboarding always creates a user and the employee role; same email reuses the account; same email in the same company gives `DUPLICATE_EMPLOYEE`; username generation vectors incl. umlauts and collisions; login by email and by username; activation by link and by code; code is single use and expires; deactivate keeps an account that has another role;
  - audit rows exist for every mutation; no PIN appears in logs.
- **E2E (Playwright):** login -> plan a week by drag and drop -> publish -> kiosk punch with PIN -> approve -> timesheet PDF downloads; keyboard path through the + menu.

## 9. Milestones (run in order, commit after each)
| # | Title | Deliverables | Done when |
|---|---|---|---|
| M0 | Scaffold | monorepo, docker compose db + MailHog, migration runner with `001_init.sql`, shared/rules packages, web app shell with design tokens, fonts and i18n seeded from `design/`, CI, `.env.example`, health endpoint | `pnpm db:migrate && pnpm test && pnpm typecheck` pass; `/health` 200; web shell renders the prototype nav in German and English |
| M1 | Auth and roles | login by email or username, role selector, refresh, invitation/activation (link and code), reset mail, TOTP, scope resolver, audit helper, rate limits, login/accept-invitation/forgot screens | auth and account tests pass; screens match the prototype login |
| M2 | Organisation and employees | companies, hotels, admins, managers, departments, kiosk devices, hotel settings, holidays, employees, contracts, personnel numbers, automatic accounts, PIN create/reset/unlock, deactivate, users list, setup status, Mitarbeiter and Einrichtung screens (except tablets/rules/audit tabs) | creating an employee returns PIN, username and code once; account and proration vectors pass; tenant isolation tests pass |
| M3 | Shifts and staffing | shift CRUD, staffing defaults and overrides, hotel/department setup screens | CRUD tests, staffing resolution test |
| M4 | Planning API and rules | `packages/rules` checks incl. `MINOR_REST`, grid with changes/counts/coverage, validate, entries, move/copy/swap/bulk/copy-week, clear-week, revert, candidates, absences, publish with snapshots and notifications | all planning, absence and snapshot tests pass |
| M5 | Planning UI | /planning per 6.2 and the prototype (both views, multi-select filters, + menu, side panel, drag and drop, changes panel, print stylesheet, locked days) | Playwright planning flow passes; side-by-side check against `design/prototype.html` for every state |
| M6 | Kiosk and live | kiosk API, heartbeat, auto-checkout job, /kiosk UI, /live API and screen, close-open | kiosk and live tests pass; punch with the seed device works end to end |
| M7 | Requests, approvals, close | worked-time approvals, corrections, vacation requests and approvals, hours visibility, periods, attendance report, Anträge screen, Tablets/Regeln/Protokoll tabs | approval, visibility, request and period-close tests pass |
| M8 | Exports and portal | schedule XLSX, timesheet PDF/XLSX, attendance CSV, audit CSV, time account, /me portal screens | files open; German labels; employee sees only own/approved data |
| M9 | Import and hardening | employee Excel import with dry run, error CSV and credentials sheet, helmet/CORS/rate limits, README, e2e suite | import tests pass; `pnpm e2e` green; README explains setup and demo logins |

## 10. Backlog (do not build in v1; see docs/full-spec.md and design/DESIGN.md)
Designed but v2: vacation planner (Urlaub view), year overview, blackout periods, half-day vacation, shift and leave wishes and "Widerspricht Wunsch" warnings, questions to management, editable rules and feature toggles, month range overview. Not designed, later: vacation notices and carryover jobs, time-account ledger and comp time, shift swaps and open shifts, availability, qualifications, documents, announcements, hour categories and payroll export (DATEV), analytics, break start/stop and badge identification, web punch, offline kiosk, rest-period compensation tracking, Sunday/night-worker checks, rule profiles, occupancy-based staffing, public API, SSO, social network, native apps. Excluded: wage/hourly-rate fields, employee sick reports in the app (planners mark sickness on the plan), biometrics, GPS.
