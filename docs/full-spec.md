# Attendance App - Final Specification

**Version:** 3.4 (final)  
**Date:** October 4, 2026  
**Status:** Final - ready for Phase 0/1  
**Replaces:** attendance-app-master-spec.md (v2.1) and all earlier spec files

---

## Table of Contents

1. Resolved Design Decisions
2. Product Concept (incl. Feature Coverage Review)
3. Architecture
4. Role Hierarchy & Permissions
5. Employee Onboarding
6. Database Schema
7. API Endpoints (Phase 1)
8. API Endpoints - Additions
9. Business Rules
10. Shift Planning Calendar
11. Data Import & Export
12. Additional Features (v3.3)
13. Legal Compliance Baseline (Germany)
14. Security
15. Tablet/Kiosk Punch System
16. Tech Stack
17. Phase Plan
18. Employee Personal Dashboard (Phase 6)
19. Social Feed & Community (Phase 8, deferred)
20. Break Tracking (ArbZG section 4)
21. Appendix: API Field Naming
22. Appendices A-G
23. Document History

---

## Resolved Design Decisions

| # | Topic | Decision |
|---|-------|----------|
| 1 | PIN | One PIN per employee, 4-8 digits (default 4). Kiosk flow: select name, then PIN. Hashed (argon2id/bcrypt), per-employee lockout, registered kiosk devices, PIN never emailed |
| 2 | Manager + employee | Single login, role selector after auth (also selects the employment if several) |
| 3 | Public holidays | National + state + company + hotel; resolution hotel > company > state > national |
| 4 | Vacation carryover | Automatic, only after documented notices; statutory days carry to 31 Mar, contractual days capped by per-employee limit |
| 5 | Overnight shifts | `shift_date` = local start date; durations from timestamps (daylight-saving safe) |
| 6 | Phase 1 scope | Everything stays in Phase 1, realistic estimate 6-8 weeks for one developer |
| 7 | PIN reset | Admin resets; new PIN shown once to the admin; old PIN invalid |
| 8 | Carryover limit | Set per employee by admin (contractual days only) |
| 9 | Manager table | No `hotel_id`; `manager_hotel` join table |
| 10 | Credentials | Every employee gets a `user_account` and the employee role automatically at onboarding (login = email or generated username); staff roles always have an email |
| 11 | Hours visibility | Admin/super admin sets per hotel: `immediately` or `after_approval` (default) |
| 12 | Worked-time approval | Manager (assigned hotels), admin (assigned companies), super admin (all) |
| 13 | Shift planning | Super admin, admin or manager; authorship stored as user + role |
| 14 | Legal baseline | Rule profiles (company, hotel override, minor/maternity overlays); legal hard limits blocked, soft rules need a reason |
| 15 | Time records | Actual punch times never overwritten; paid times separate; full change history; review within 7 days; month-end lock |
| 16 | Employment model | `employee` = one employment per company; effective-dated `employee_contract`; vacation and time account per employee, not per hotel |
| 17 | Vacation law | BUrlG proration, statutory vs contractual days, half days, holiday-aware counting, sick-during-vacation refund |
| 18 | Time account | Ledger; monthly target = weekly x 52/12; vacation/sick/holiday credited at daily target; optional min/max alerts |
| 19 | Schedule | Split shifts allowed; overlap blocked across hotels; draft/published with change notifications |
| 20 | Manager visibility | Display name (first name + last initial); no email, contact data, date of birth or PIN |
| 21 | Social feed | Read-only announcements in Phase 6; social network deferred to Phase 8 pending legal/works council sign-off |
| 22 | Data protection | Retention policy (default 36 months), GDPR export, EU hosting, processor agreements, works council checklist |
| 23 | Payroll export | Phase 7: CSV and DATEV, closed periods only |
| 24 | Sickness | Reported to the manager by phone or in person (not through the app). Planners mark sick days on the plan, also for past days: managers up to 7 days back (company setting), admin/super admin any date with a reason |
| 25 | Planning calendar | Employee view and Shift view, week planning with month overview, totals column on the right (per week or month); drag and drop in both views, always validated by the server |
| 26 | Grid actions | Selected chip has a cut icon that removes the entry; hover on an empty cell shows + with an anchored menu: shifts or employees, plus Sick leave, Free day, Vacation, Unpaid day off |
| 27 | Headcount | Required headcount per shift (weekday default, date override); open slots shown in shift view; shortage warns on publish, never blocks |
| 28 | Imports and exports | One import pipeline (template, dry run, confirm, atomic commit, error CSV) for 7 import types; 12 export types incl. schedule PDF/Excel, timesheet (Stundenzettel) PDF, reports, payroll, audit log, GDPR export, calendar feed; all role-scoped and audit-logged |
| 29 | Product concept | Vision, module map, end-to-end flow, notification catalogue, non-functional targets, environments, rollout and success measures are part of the spec |
| 30 | Feature review | Benchmarked against German hospitality tools; coverage matrix in Product Concept; gaps added or consciously deferred/excluded |
| 31 | Swaps, open shifts, availability, qualifications | Employees offer and swap shifts (server-checked, manager approves by default), apply for open shifts, maintain availability; shifts can require a qualification |
| 32 | Absences | Absence-type table (incl. comp time, special leave, child sick, training, parental and maternity leave); vacation blackouts and minimum staffing; privacy-safe team calendar |
| 33 | Documents and offboarding | Encrypted personnel documents with expiry reminders; termination flow with exit statement and automatic PIN/login shutdown |
| 34 | Recording options | Optional badge + PIN, optional break start/stop, web punch restricted to hotel networks, no-show alerts; biometrics and GPS excluded |
| 35 | Hour categories and analytics | Configurable categories produce payroll-ready minutes (no wage calculation); aggregated analytics with minimum group size 5, no per-employee scoring |
| 36 | Later | Occupancy-based staffing suggestions, auto-fill suggestions, API, SSO in Phase 9; native apps out of scope (PWA) |
| 37 | Employee accounts | Onboarding (single or import) always creates or links a user account and assigns the employee role. An existing account with the same email is reused (multi-employment); no email means a generated username and a one-time activation code shown once on the printed slip with the PIN. The employee is active for the kiosk immediately; activation only concerns web login |

**Still open (defaults applied):** (a) shift wish vs. time-off: approved time-off wins; (b) worked-time approval: only flagged records need review, clean ones auto-approve; (c) hours-visibility setting is per hotel; (d) items listed in Legal Compliance Baseline F need counsel confirmation.

---

## Product Concept

**Vision:** one place where a German hotel plans shifts, records real working time on a shared tablet, gets it approved, stays inside working-time law and hands clean data to payroll - with far less paper, phone calls and Excel.

**Problems solved:** shift plans in Excel/WhatsApp; handwritten timesheets; unclear overtime and vacation balances; legal exposure (recording duty, breaks, rest periods, vacation notices); manual payroll preparation.

**Users:** super admin (group IT/HR), admin (HR/office per company), manager (department or hotel manager, also front-office leads), employee (50-100 per hotel, many without email, multilingual), plus the shared kiosk tablet.

**Product principles**
1. Actual times are the record; everything else is derived and reversible.
2. The server enforces the law; the browser only shows it.
3. Rules are data (rule profiles), not code.
4. Least privilege and data minimisation by role.
5. Fast for the manager (planning in minutes), trivial for the employee (a name and a PIN).

### Module map

| Module | Main users | Phase |
|---|---|---|
| Accounts, roles, multi-company/hotel | all | 1 |
| Employee onboarding, contracts, Excel import | admin | 1 |
| Shift planning calendar, headcount, publishing | manager, admin, super admin | 1 |
| Kiosk punch, breaks, grace period, auto-checkout, corrections | employee, kiosk | 1 |
| Worked-time approval, hours visibility, month close | manager, admin | 2 |
| Compliance engine (ArbZG, JArbSchG, MuSchG) | manager, admin | 3 |
| Vacation, sickness on the plan, time account | all | 4 |
| Shift and leave wishes | employee, manager | 5 |
| Employee dashboard, announcements | employee | 6 |
| Imports, exports, reports, payroll export | admin, manager | 1-7 (see Data Import & Export) |
| Social network | employee | 8, deferred |

### End-to-end flow

Hire -> admin creates employee + contract (PIN slip) -> manager plans and publishes the week -> employee clocks in/out on the kiosk (name + PIN) and confirms the break -> flagged records go to the approval inbox, clean ones auto-approve -> sickness and absences are marked on the plan -> compliance report and corrections -> admin closes the month -> payroll export and timesheets -> retention job removes expired data.

### Notification catalogue

| Event | Recipient | Channel | Timing |
|---|---|---|---|
| Schedule published / changed | employee | in-app + email | immediately; changes inside the notice period flagged to manager |
| Approval decision (variation, correction, time-off) | employee | in-app | immediately |
| Record waiting for review | manager | in-app + daily email digest | day 0; reminder day 5; escalation to admin day 7 |
| Auto-checkout happened | manager, employee | in-app | at auto-checkout |
| Vacation notices (initial, reminder, final) | employee | email + in-app | 1 Oct, 15 Nov, 15 Feb (configurable) |
| PIN locked 3 times in 24 h | admin | in-app + email | immediately |
| Kiosk offline / clock drift | admin | in-app + email | after 10 min / 60 s drift |
| Open slots at publish | manager | in-app | at publish |
| Import / export job finished | requester | in-app | on completion |
| No punch 15 min after planned start | manager (employee reminder if account) | in-app | 15 min after start |
| Swap request received / accepted / decided | employee, planner | in-app + email | immediately |
| Open shift published / claim decided | eligible employees, planner | in-app | immediately |
| Qualification, document, contract or probation expiring | admin | in-app + email | 30 and 7 days (contract/probation 30 and 14) |
| Announcement needing confirmation | employee | in-app | at publish; reminder after 3 days |

### Non-functional targets (proposed, confirm with hosting choice)

| Area | Target |
|---|---|
| Scale | 50 hotels, 5,000 employees at launch; design for 10x |
| Performance | planning grid under 1.5 s for 60 employees; validation call under 300 ms; kiosk punch confirmation under 2 s |
| Availability | 99.5% overall, 99.9% for kiosk punch endpoints during staffing hours; kiosk offline mode covers outages up to 24 h |
| Backup | continuous WAL archiving (point-in-time recovery), RPO 15 min, RTO 4 h, restore test every quarter |
| Browsers/devices | current Chrome, Edge, Safari, Firefox; iOS/Android browsers; iPad/Android tablets for the kiosk |
| Languages | German and English at launch (`preferred_language`), more later; legal documents (timesheets, notices) in German |
| Accessibility | WCAG 2.1 AA for employee-facing screens |

### Environments, delivery and operations

- Dev, staging (anonymised data), production; EU region only.
- Docker, GitHub Actions CI/CD, versioned SQL migrations, feature flags for phased rollout.
- Logging without personal data, metrics and alerts (failed punch rate, kiosk offline, job failures, 5xx rate), uptime check on the kiosk endpoints.
- Tests: unit tests for the rule engine (incl. the two daylight-saving shifts, break formula edge cases, vacation proration), API integration tests per role, end-to-end test of the kiosk flow, load test of the grid and punch endpoints, security tests (IDOR across companies, PIN lockout).

### Rollout and success measures

- Phase 0 sign-offs, then a pilot in one hotel in parallel with the existing process for one full month close.
- Training: 30-minute manager session, one-page PIN/kiosk guide for employees in their language.
- Success measures: share of punches on time-without-correction, hours of manual planning per week, number of open approvals older than 7 days, rule overrides per month, month close completed within 3 working days.

### Feature coverage review

Benchmark: German hospitality tools (e.g. gastromatic, Papershift, Shiftbase) and common HR-suite scheduling modules. Status: Included, Added (v3.3), Deferred, Excluded.

| Capability | Market standard | Status |
|---|---|---|
| Online shift planning, drag and drop, publish with notification | yes | Included |
| Split shifts, department/hotel filters, week and month views | yes | Included |
| Required headcount / coverage | yes | Included |
| Copy week, templates | yes | Included (bulk copy) |
| Shift swap and giveaway | yes | Added (Phase 5) |
| Open shifts employees can apply for | common | Added (Phase 5) |
| Availability and preferences | yes | Added (Phase 5) |
| Floaters across hotels (Springer) | gastromatic | Added |
| Qualification-based planning | common | Added |
| Time recording at terminal | yes | Included (name + PIN, optional badge) |
| Time recording by smartphone | yes | Included as controlled web punch (network restriction); PWA |
| Break handling | yes | Included (confirm at clock-out; optional start/stop) |
| Working-time law monitoring | yes | Included (rule profiles) |
| Automatic surcharges | gastromatic | Added as hour-category minutes (no wage calculation) |
| Earnings/hours limits for mini-jobs | gastromatic | Included (hours cap) |
| Time account with comp time | yes | Included + comp_time |
| Vacation planning and balances | yes | Included |
| More absence types, blackouts, minimum staffing | common | Added |
| Team absence calendar | common | Added (privacy-safe) |
| Electronic sick notes | gastromatic Professional | Excluded (manual certificate tracking) |
| Digital personnel file, documents, expiry | gastromatic | Added |
| Payslips in the app | gastromatic | Via documents (optional) |
| Payroll interface (DATEV) | yes | Included (Phase 7) |
| Reports and KPIs | yes | Added (aggregated, privacy-safe) |
| Occupancy/revenue-linked staffing | gastromatic USP | Added optional (Phase 9) |
| Automatic plan generation | emerging | Deferred |
| Individual access rights | gastromatic Professional | Included (4 roles, department scope) |
| Multi-location, multi-company | yes | Included |
| Announcements with read confirmation | common | Added |
| Audit trail, corrections, month close | needed in DE | Included |
| Offboarding and exit statement | HR standard | Added |
| Multi-language | needed | Included |
| Offline kiosk | needed | Included |
| Biometric clock, GPS tracking | some vendors | Excluded (GDPR, works council) |
| Public API, SSO | enterprise | Deferred |
| Chat, social network | some | Deferred |

### Out of scope

Payroll calculation and wage data, PMS or channel-manager integration, native mobile apps (responsive web and kiosk only), the social network until Phase 8.

---

## Architecture

### Account Types (Four Separate Systems)

**1. SUPER_ADMIN**
- One account per system (manually created, cannot create other super-admins)
- Access: All companies, all hotels, all employees, all data
- Responsibilities: Create companies, assign admins, manage public holidays, system configuration

**2. ADMIN**
- Assigned to specific company(ies)
- Access: Employees, managers, hotels within assigned companies only
- Responsibilities: Create employee profiles with employment terms, create/assign managers, manage departments, approval workflows

**3. MANAGER**
- Assigned to specific hotel(s) within assigned company
- Access: Hours-related data only (schedules, worked hours, targets, arbeitszeitkonto), NOT personal data
- Responsibilities: Create shifts, assign shifts to employees, approve time-off, assign sick leave, view audit logs

**4. EMPLOYEE**
- Assigned to primary hotel + department
- Access: Own data only (schedule, worked hours, time-off balance, wishes)
- Responsibilities: Clock in/out via PIN, request time-off, submit shift/leave wishes, view personal information

### Data Visibility Matrix

| Data | Employee | Manager | Admin | Super-Admin |
|------|----------|---------|-------|-------------|
| Own schedule/hours | ✅ | ✅ | ✅ | ✅ |
| Other employees' hours | ❌ | ✅ | ✅ | ✅ |
| Personal data (name/email/PIN) | Own only | ❌ | ✅ | ✅ |
| Company-wide data | ❌ | ❌ | Assigned only | ✅ |
| All companies | ❌ | ❌ | ❌ | ✅ |

### Multi-Company & Multi-Hotel Structure

```
SUPER_ADMIN (1 account)
  ├─ COMPANY 1
  │   ├─ HOTEL A (assigned to ADMIN-1)
  │   │   ├─ DEPARTMENT: Front Desk
  │   │   ├─ DEPARTMENT: Housekeeping
  │   │   ├─ MANAGER-1 (assigned to HOTEL A)
  │   │   └─ EMPLOYEES: 20+
  │   │
  │   └─ HOTEL B (assigned to ADMIN-1)
  │       ├─ DEPARTMENT: Restaurant
  │       ├─ MANAGER-2 (assigned to HOTEL B)
  │       └─ EMPLOYEES: 15+
  │
  └─ COMPANY 2
      └─ HOTEL C (assigned to ADMIN-2)
          ├─ DEPARTMENT: All
          ├─ MANAGER-3 (assigned to HOTEL C)
          └─ EMPLOYEES: 30+
```

---

## Role Hierarchy & Permissions

### SUPER_ADMIN

**Can Do:**
- Create new companies
- Create and assign ADMIN users to companies
- Create hotels for any company
- Create and assign MANAGER users to any hotel
- Create and manage all EMPLOYEE profiles
- View all personal data + hours data
- Delete/deactivate any user (admin/manager/employee)
- Manage public holidays (all hotels)
- Record overtime payments (all employees)
- View audit logs (all companies/hotels)
- Access system configuration & settings
- Plan shifts and edit the schedule (all hotels); mark sick days on the plan for any date (reason required)
- Approve/reject worked time (all hotels)
- Set whether employees see worked hours before approval (any hotel)

**Cannot Do:**
- Create other SUPER_ADMIN accounts

---

### ADMIN

**Can Do (Within Assigned Companies Only):**
- View all hotels in assigned companies
- Create and manage employee profiles (personal data + employment terms)
- View full employee profiles (personal + hours data)
- Create and assign MANAGER users to hotels
- Create and manage departments
- Delete/deactivate managers and employees
- Plan shifts and edit the schedule (all hotels in assigned companies); mark sick days on the plan for any past date (reason required beyond the manager limit)
- Approve/reject worked time (time variations, auto-checkouts, punch records) in assigned companies
- Set whether employees see worked hours before or only after approval (hotels in assigned companies)
- Assign and manage time-off
- View company reporting (assigned companies only)
- Manage public holidays (assigned companies/hotels)
- Record overtime payments (assigned companies/employees)
- View audit logs (assigned companies only)

**Cannot Do:**
- Create other ADMIN accounts
- Create new companies
- View data outside assigned companies
- See personal data for managers

---

### MANAGER

**Can Do (Within Assigned Hotels Only):**
- Create shifts and departments
- Plan shifts: assign shifts to employees (with soft warnings); scope can be limited to departments (`manager_department`)
- Approve shift swaps and open-shift claims
- Approve/reject worked time (time variations, auto-checkouts, punch records) in assigned hotels
- View hours-related data: schedules, worked hours, work targets, arbeitszeitkonto, overtime payments
- View employees by display name (first name + last initial) and their shift assignments
- View full schedule grid (who's working when) across assigned hotels
- Approve/reject employee time-off requests (all assigned hotels)
- Approve/reject employee shift wishes (all assigned hotels)
- Mark employees as sick on the plan, including past days (up to 7 days back, configurable)
- Set work targets per employee
- Record overtime payments for employees
- View audit logs (all assigned hotels)

**Cannot Do:**
- View full personal data: full last name, email, contact info, date of birth, PINs
- Change the employee hours-visibility setting (admin / super admin only)
- Create or delete employees
- Create other managers
- View data outside assigned hotels

---

### EMPLOYEE

**Can Do:**
- View own schedule (assigned shifts)
- View own worked hours (week/month summary)
- View own vacation days remaining
- View own arbeitszeitkonto balance (if salary worker)
- Clock in/out on tablet using personal_number (PIN)
- Request time-off (annual_leave, unpaid_leave)
- Submit shift wishes (date + shift + priority)
- Submit leave wishes (date range + priority)

**Cannot Do:**
- Report sickness in the app (employees tell their manager by phone or in person; the manager records it on the plan)
- View other employees' data
- Manage schedules or approvals
- View audit logs

---

## Employee Onboarding

> v3.0: PINs are never emailed, contract terms are effective-dated, vacation follows BUrlG; see "Onboarding Flow (v2.2)" and the field table below. Older examples in this section show the original field set.

**Two Methods:**
1. Single employee: `POST /admin/employees` (API form)
2. Bulk import: `POST /admin/employees/import` (Excel file)

### Method 1: Single Employee via API

**Endpoint:** `POST /admin/employees`

**Personal & Contact (Required)**
- firstName (String)
- lastName (String)
- email (String, unique)

**Employment Structure (Required)**
- primaryHotelId (Integer) — Main hotel assignment
- primaryDepartmentId (Integer) — Main department assignment
- contractStartDate (Date) — Actual start date (supports retroactive)
- contractEndDate (Date, nullable) — null = ongoing contract
- workingModel (Enum) — 'hourly' or 'salary'

**Work Hours (Optional)**
- targetHoursPerWeek (Decimal, optional) — e.g., 35, 40, 20
- targetHoursPerMonth (Decimal, optional) — e.g., 140, 160, 80
- **Flexibility:** Admin can provide weekly only → system calculates monthly using 4.3333 multiplier
  - Admin can provide monthly only → system calculates weekly
  - Admin can provide both → both stored as-is
  - Admin can provide neither → both null (no hour tracking/warnings/arbeitszeitkonto)

**Vacation (Required & Optional Mix)**
- vacationDaysPerYear (Integer, required) — e.g., 20, 25, 30
- vacationDaysAllocatedThisYear (Integer, optional) — Auto-prorated if omitted
- vacationDaysUsedThisYear (Integer, optional) — For retroactive onboarding
- restVacationDaysPerYear (Integer, optional) — Additional rest days
- getsPublicHoliday (Boolean, optional) — true/false; if true and salaried, public holiday hours → arbeitszeitkonto

**Overtime Account (Optional, Salary Workers Only)**
- arbeitszeitkontoBalance (Decimal, optional) — Starting balance (can be positive/negative)
  - Only applies if workingModel='salary'
  - +12.5 = company owes employee 12.5 hours
  - -3.0 = employee owes company 3 hours
  - Default: 0 if omitted

### Onboarding Examples

**Example 1: Full-Time Salary Employee (New Hire)**
```json
{
  "firstName": "Maria",
  "lastName": "Schmidt",
  "email": "maria@hotel.de",
  "primaryHotelId": 1,
  "primaryDepartmentId": 5,
  "workingModel": "salary",
  "contractStartDate": "2026-11-01",
  "contractEndDate": null,
  "targetHoursPerWeek": 40,
  "targetHoursPerMonth": null,         // System calculates: 40 × 4.3333 = 173.3
  "vacationDaysPerYear": 30,
  "getsPublicHoliday": true
}
```

Response:
```json
{
  "employeeId": 1,
  "personalNumber": "5729",
  "status": "pending_invite",
  "targetHoursPerWeek": 40,
  "targetHoursPerMonth": 173.3,        // Calculated
  "vacationDaysPerYear": 30,
  "vacationDaysAllocatedThisYear": 5,  // Prorated: Nov-Dec = ~5 days
  "remainingVacationDays": 5,
  "arbeitszeitkontoBalance": 0,
  "invitationExpiresAt": "2026-11-02T10:00:00Z"
}
```

**Example 2: Retroactive Onboarding (Worked Jan-June, Added in June)**
```json
{
  "firstName": "Klaus",
  "lastName": "Weber",
  "email": "klaus@hotel.de",
  "primaryHotelId": 1,
  "primaryDepartmentId": 5,
  "workingModel": "salary",
  "contractStartDate": "2026-01-15",   // Actual start (retroactive)
  "contractEndDate": null,
  "targetHoursPerMonth": 160,
  "vacationDaysPerYear": 30,
  "vacationDaysAllocatedThisYear": 30, // Full year
  "vacationDaysUsedThisYear": 5,       // Already used Jan-June
  "arbeitszeitkontoBalance": 3.0       // From manual HR tracking
}
```

Response:
```json
{
  "employeeId": 2,
  "targetHoursPerWeek": 36.9,          // Calculated: 160 / 4.3333
  "targetHoursPerMonth": 160,
  "vacationDaysPerYear": 30,
  "vacationDaysAllocatedThisYear": 30,
  "vacationDaysUsedThisYear": 5,
  "remainingVacationDays": 25,
  "arbeitszeitkontoBalance": 3.0,
  "message": "Employee created (retroactive). 25 vacation days remaining. +3h overtime on the books."
}
```

**Example 3: Part-Time Hourly Worker (No Hour Targets)**
```json
{
  "firstName": "Petra",
  "lastName": "Casual",
  "email": "petra@hotel.de",
  "primaryHotelId": 1,
  "primaryDepartmentId": 6,
  "workingModel": "hourly",
  "contractStartDate": "2026-01-01",
  "targetHoursPerWeek": null,          // No targets
  "targetHoursPerMonth": null,
  "vacationDaysPerYear": 25
}
```

Response:
```json
{
  "employeeId": 3,
  "targetHoursPerWeek": null,
  "targetHoursPerMonth": null,
  "message": "Hourly employee created without work hour targets. No warnings during planning."
}
```

---

### Method 2: Bulk Import via Excel File

**Endpoint:** `POST /admin/employees/import`

**Request:**
- Multipart form-data
- Field: `file` (Excel .xlsx only, max 10 MB)
- Field: `dryRun` (optional boolean, default: false)
- Field: `onDuplicateEmail` (optional string, default: 'skip')
  - `'skip'` — Skip rows with emails already in system (continue with others)
  - `'update'` — Update existing employee's employment terms (overwrite)
  - `'conflict'` — Flag as conflict; report them separately; admin decides per row

**Response (202 Accepted for async / 200 OK for dry-run):**
```json
{
  "jobId": "import_20261004_1234567890",
  "status": "processing" | "dry_run_complete" | "import_complete" | "conflicts_pending" | "import_failed",
  "onDuplicateEmailMode": "skip" | "update" | "conflict",
  "summary": {
    "totalRows": 150,
    "successful": 148,
    "failed": 2,
    "skipped": 0,
    "conflicts": 0,
    "updated": 0
  },
  "errors": [
    {
      "rowNumber": 5,
      "employee": "John Doe (john@hotel.de)",
      "errorType": "email_duplicate",
      "error": "Email already exists (employeeId: 42)",
      "existingEmployeeId": 42,
      "action": "skip" | "update" | "conflict"
    },
    {
      "rowNumber": 127,
      "employee": "Maria Schmidt",
      "errorType": "validation",
      "error": "Missing required field: primaryHotelId",
      "action": "halt"
    }
  ],
  "conflicts": [
    {
      "rowNumber": 8,
      "email": "james@hotel.de",
      "existingEmployeeId": 99,
      "newData": {
        "firstName": "James",
        "lastName": "Wilson",
        "workingModel": "salary",
        "targetHoursPerWeek": 40,
        "vacationDaysPerYear": 30
      },
      "existingData": {
        "firstName": "Jim",
        "lastName": "Wilson",
        "workingModel": "hourly",
        "targetHoursPerWeek": 35,
        "vacationDaysPerYear": 25
      },
      "decision": "awaiting_decision"
    }
  ],
  "downloadUrl": "/admin/imports/{jobId}/errors.csv",
  "conflictUrl": "/admin/imports/{jobId}/conflicts.csv",
  "createdEmployees": [
    { "id": 123, "email": "alice@hotel.de", "personalNumber": "5729" },
    { "id": 124, "email": "bob@hotel.de", "personalNumber": "3841" }
  ],
  "updatedEmployees": [
    { "id": 42, "email": "john@hotel.de", "changedFields": ["targetHoursPerWeek", "vacationDaysPerYear"] }
  ],
  "importedAt": "2026-10-04T10:15:00Z",
  "totalProcessingTime": "2.34s"
}
```

---

#### Excel Template Specification

**File Format:** `.xlsx` (Excel 2007+), max 10 MB, max 5000 rows

**Columns (in order, header row required):**

| # | Column | Type | Required? | Validation | Notes |
|---|--------|------|-----------|-----------|-------|
| A | firstName | String | ✅ | 1-100 chars | Trimmed |
| B | lastName | String | ✅ | 1-100 chars | Trimmed |
| C | email | String | ✅ | RFC 5322 format | Unique in system |
| D | primaryHotelId | Integer | ✅ | > 0, exists in HOTEL | Hotel must exist |
| E | primaryDepartmentId | Integer | ✅ | > 0, exists in DEPARTMENT | Must belong to the hotel |
| F | workingModel | String | ✅ | 'hourly' OR 'salary' | Case-insensitive |
| G | contractStartDate | Date | ✅ | YYYY-MM-DD or Excel date | Can be past (retroactive) |
| H | contractEndDate | Date | Optional | YYYY-MM-DD or Excel date | NULL = ongoing |
| I | targetHoursPerWeek | Decimal | Optional | 0-168 | Used for auto-calc of monthly |
| J | targetHoursPerMonth | Decimal | Optional | 0-744 | Used for auto-calc of weekly |
| K | vacationDaysPerYear | Decimal | ✅ | 0-365 | Annual entitlement |
| L | vacationDaysAllocatedThisYear | Decimal | Optional | ≤ vacationDaysPerYear | Prorated if omitted |
| M | vacationDaysUsedThisYear | Decimal | Optional | ≤ allocated | For retroactive |
| N | restVacationDaysPerYear | Decimal | Optional | 0-30 | Extra vacation days |
| O | getsPublicHoliday | Boolean | Optional | TRUE/FALSE, Y/N, 1/0 | Default: TRUE |
| P | arbeitszeitkontoBalance | Decimal | Optional | -999 to +999 | Salary workers only |

**Download Template:**
```
GET /admin/employees/import-template
```
Returns: Excel file with headers + 1 example row (fully populated)

---

#### Import Processing

**Processing Mode:**
- **Synchronous (< 100 rows):** Return 200 OK with results immediately
- **Asynchronous (≥ 100 rows):** Return 202 Accepted with jobId, process in background

**Polling (for async imports):**
```
GET /admin/imports/{jobId}
```

**Dry Run Mode** (`dryRun=true`):
- Validate all rows without creating records
- Return validation summary + errors
- Admin can review, fix Excel, and resubmit

---

#### Import Validation Rules

**Row-Level Validation (each row checked):**
1. ✅ Required fields non-empty
2. ✅ Email format valid & unique in system
3. ✅ primaryHotelId exists
4. ✅ primaryDepartmentId exists AND belongs to hotel
5. ✅ workingModel is 'hourly' or 'salary'
6. ✅ contractStartDate is valid date ≤ today
7. ✅ contractEndDate (if present) ≥ contractStartDate
8. ✅ targetHoursPerWeek (if present): 0-168
9. ✅ targetHoursPerMonth (if present): 0-744
10. ✅ vacationDaysPerYear: 0-365
11. ✅ vacationDaysAllocatedThisYear ≤ vacationDaysPerYear
12. ✅ vacationDaysUsedThisYear ≤ vacationDaysAllocatedThisYear
13. ✅ arbeitszeitkontoBalance only if workingModel='salary'

**Global Validation:**
- No duplicate emails within file
- No duplicate emails in system

---

#### Error Handling Strategy

| Error Type | Action |
|-----------|--------|
| Row validation fail (e.g., bad email format) | Skip row, log error, continue |
| **Duplicate email in system** | Depends on `onDuplicateEmail` mode (see below) |
| Duplicate email in file | Skip row, log error, continue |
| Missing required field | Skip row, log error, continue |
| System error (e.g., DB write fails) | **Halt entire import, rollback all records** |
| Cross-hotel dept mismatch | Skip row, log error, continue |

**Handling Duplicate Emails (onDuplicateEmail Parameter):**

| Mode | Behavior | Use Case |
|------|----------|----------|
| **skip** (default) | Email exists → skip row, log error, continue | Conservative; no existing data touched |
| **update** | Email exists → update employment terms; create if new | Bulk refresh/correction of contracts |
| **conflict** | Email exists → flag for manual review; ask admin per row | Careful approval; avoid unintended overwrites |

**Skip Mode Example:**
```
Row 5: john@hotel.de already exists (employeeId 42)
→ Skip this row
→ Report: "Email already exists; skipped"
→ john@hotel.de unchanged; continue with row 6
```

**Update Mode Example:**
```
Row 5: john@hotel.de already exists (employeeId 42)
→ Update employeeId 42's employment terms
→ Updated fields: targetHoursPerWeek (35→40), vacationDaysPerYear (25→30)
→ PIN & status unchanged; contract terms refreshed
→ Report: "Updated 1 employee"
```

**Conflict Mode Example:**
```
Row 8: james@hotel.de exists (employeeId 99)
→ Flag as CONFLICT — show existing vs. new data
→ Import status: conflicts_pending
→ Admin reviews side-by-side and approves/skips each row

Then POST to resolve:
POST /admin/imports/{jobId}/resolve-conflicts
{
  "decisions": [
    { "rowNumber": 8, "email": "james@hotel.de", "decision": "update" },
    { "rowNumber": 15, "email": "petra@hotel.de", "decision": "skip" }
  ]
}

Response: import resumes & completes
```

**Skipped rows do NOT block import completion.** Admins receive error CSV to review and resubmit.

---

#### Import Results & Audit

**On Success:**

For each imported employee:
1. ✅ Create EMPLOYEE record (status = 'pending_invite')
2. ✅ Generate personalNumber (4-digit PIN)
3. ✅ Create invitation token (24-hour expiry)
4. ✅ Auto-create EMPLOYEE_VACATION_ALLOWANCE
5. ✅ Auto-create ARBEITSZEITKONTO (if salary)
6. ✅ Queue invitation emails (batched, not immediate)
7. ✅ Log audit: "Bulk import: N employees added by {admin_name}"

**Error Report (CSV):**
```
rowNumber,firstName,lastName,email,errorMessage,recommendedAction
5,John,Doe,john@hotel.de,Email already exists,Review or update email
127,Maria,Schmidt,maria@smith.de,Missing required field: primaryHotelId,Add hotel ID
```

Download URL: `/admin/imports/{jobId}/errors.csv`

---

### Onboarding Flow (v2.2)

1. Admin submits the form (employee data + first contract version).
2. System creates:
   - `employee` row (status `active`) and `employee_contract` version 1 (`valid_from = contractStartDate`)
   - PIN (4-8 digits per company setting), stored hashed; shown ONCE on the admin's screen (and on a printable PIN slip). It is never emailed.
   - `user_account` with the employee role, ALWAYS and automatically: an existing account with the same email is reused (no new invitation, the person gets an additional employment); otherwise a new account is created with `status = pending_invite`, the email (optional) and a generated `username` (e.g. `juergen.mueller`, `maria.schmidt2` on collision).
   - Activation: with email, an invitation link (24 h). Without email, a one-time activation code (7 days) shown once next to the PIN on the printed slip together with the username. Only hashes are stored.
   - `employee_vacation_allowance` for the current year, `arbeitszeitkonto` (salary workers with targets) incl. `opening_balance` ledger entry
3. Invitation email (employee's language) contains only the registration link and a contract summary - no PIN.
4. Employee sets a password (via link, or username + activation code) -> `user_account.status = active`. The PIN is handed over separately (slip).
5. The employee can clock in/out on the kiosk with name + PIN immediately, before activating the web account.
6. At the next login the employee role appears in the role selector automatically.

**Field changes in v2.2 (single create and Excel import)**

| Field | Required | Notes |
|---|---|---|
| dateOfBirth | yes | minor protection (JArbSchG) is derived from it |
| workDaysPerWeek | yes | 1-7; drives daily target, statutory vacation minimum and day counting |
| employmentType | yes | full_time, part_time, minijob, werkstudent, apprentice, short_term, other |
| email | no | optional; without it a username and an activation code are generated |
| preferredLanguage | no | default `de` |
| carryoverLimitDays | no | contractual days only |
| monthlyHoursCap | no | e.g. minijob limit translated into hours |
| accountMinHours / accountMaxHours | no | alert thresholds for the time account |
| workTimeProtection | no | `none` or `maternity`, admin/super admin only |

Contract changes (new hours, new vacation entitlement, new employment type) create a new `employee_contract` version with `validFrom`; nothing is overwritten (`PUT /admin/employees/:id/contract`).

### Vacation Calculation (BUrlG § 5, see Legal Compliance Baseline B)

```
statutoryDays  = MIN(vacationDaysPerYear, 4 x workDaysPerWeek)
if waiting period (6 months) is completed within the calendar year:
    allocated = vacationDaysPerYear                 -- full year
else:
    fullMonths = number of full months employed in the year
    allocated  = round_half_up(vacationDaysPerYear x fullMonths / 12)
(admin may override vacationDaysAllocatedThisYear)

Examples with 30 days/year:
  start 15 Jan -> waiting period ends 15 Jul (same year)  -> 30 days
  start 1 Nov  -> 2 full months                           -> 5 days
  start 31 Dec -> 0 full months                           -> 0 days
```

### Work Hours Calculation

```
monthly target = targetHoursPerMonth, or targetHoursPerWeek x 52 / 12 (4.3333)
weekly target  = targetHoursPerWeek, or targetHoursPerMonth x 12 / 52
daily target   = weekly target / workDaysPerWeek        -- used for absence credits
both given     -> stored as entered
neither given  -> no hour tracking, no warnings, no time account
Example: 40 h/week -> 173.3 h/month; 160 h/month -> 36.9 h/week
```

---

## Database Schema

All timestamps TIMESTAMPTZ (shown in each hotel's timezone, default Europe/Berlin), dates DATE, times TIME, paid hours DECIMAL(5,2). snake_case in DB, camelCase in API. Durations are ALWAYS computed from timestamps, never from stored hour counts (daylight-saving safe).

### Extensions, Credentials & Core Tables

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- needed for exclusion constraints

-- One login per person. Every employee gets a user_account AUTOMATICALLY at onboarding
-- (login = email or generated username). Managers/admins always have an email.
-- A person who is manager AND employee shares ONE user_account (role selector after login);
-- a person employed by two companies has one user_account and two employee rows.
CREATE TABLE user_account (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255),                      -- optional for employees; required for staff roles (app-enforced)
  username VARCHAR(60),                    -- generated for employees without email (login identifier)
  password_hash VARCHAR(255),              -- bcrypt(12) or argon2id; NULL until invitation accepted
  totp_secret_enc BYTEA,                   -- 2FA, mandatory for admin and super_admin
  status VARCHAR(20) NOT NULL DEFAULT 'pending_invite',   -- pending_invite, active, disabled
  invitation_token_hash VARCHAR(255),      -- hash of the invitation token or one-time activation code
  invitation_expires_at TIMESTAMPTZ,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (email IS NOT NULL OR username IS NOT NULL)
);
CREATE UNIQUE INDEX uq_user_email_ci ON user_account (lower(email));
CREATE UNIQUE INDEX uq_user_username_ci ON user_account (lower(username));

-- Staff accounts (created before company because company references super_admin)
CREATE TABLE super_admin (
  super_admin_id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL REFERENCES user_account(id),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE admin (
  admin_id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL REFERENCES user_account(id),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  created_by_id INTEGER NOT NULL REFERENCES super_admin(super_admin_id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- No hotel_id: hotel assignment via manager_hotel (many-to-many)
CREATE TABLE manager (
  manager_id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL REFERENCES user_account(id),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  created_by_id INTEGER NOT NULL REFERENCES admin(admin_id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE company (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  grace_period_minutes INTEGER NOT NULL DEFAULT 15,
  retention_months INTEGER NOT NULL DEFAULT 36,          -- legal minimum for time records is 24
  schedule_change_notice_days INTEGER NOT NULL DEFAULT 4,
  sick_backdate_days INTEGER NOT NULL DEFAULT 7,         -- how far back managers may mark sick days on the plan
  pin_length SMALLINT NOT NULL DEFAULT 4 CHECK (pin_length BETWEEN 4 AND 8),
  managers_can_see_phone BOOLEAN NOT NULL DEFAULT FALSE,
  team_absence_visibility VARCHAR(10) NOT NULL DEFAULT 'none' CHECK (team_absence_visibility IN ('none','names_only')),
  swap_approval VARCHAR(15) NOT NULL DEFAULT 'manual' CHECK (swap_approval IN ('manual','auto_if_valid')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by_id INTEGER NOT NULL REFERENCES super_admin(super_admin_id)
);

-- Working-time rules as data, not code (statutory defaults, collective agreement, minors, maternity).
-- See "Legal Compliance Baseline" for the rule keys and default enforcement levels.
CREATE TABLE rule_profile (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES company(id),             -- NULL = system template
  name VARCHAR(100) NOT NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('standard','collective_agreement','minor','maternity')),
  rules JSONB NOT NULL,
  valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE company ADD COLUMN rule_profile_id INTEGER REFERENCES rule_profile(id);

CREATE TABLE hotel (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company(id),
  name VARCHAR(255) NOT NULL,
  city VARCHAR(100),
  federal_state VARCHAR(2),                -- e.g. 'HE'; drives state-level holidays
  employee_hours_visibility VARCHAR(20) NOT NULL DEFAULT 'after_approval'
    CHECK (employee_hours_visibility IN ('immediately','after_approval')),  -- set by admin/super admin
  allow_web_punch BOOLEAN NOT NULL DEFAULT FALSE,        -- remote clock-in from web/app (off by default)
  web_punch_allowed_cidrs TEXT[],                        -- web punch only from these networks
  break_mode VARCHAR(20) NOT NULL DEFAULT 'confirm_at_clock_out' CHECK (break_mode IN ('confirm_at_clock_out','start_stop')),
  kiosk_identification VARCHAR(10) NOT NULL DEFAULT 'name_pin' CHECK (kiosk_identification IN ('name_pin','badge_pin')),
  rule_profile_id INTEGER REFERENCES rule_profile(id),   -- optional override of company profile
  timezone VARCHAR(50) NOT NULL DEFAULT 'Europe/Berlin',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE department (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  name VARCHAR(100) NOT NULL,
  color VARCHAR(7),
  max_concurrent_absent INTEGER,                         -- NULL = unlimited
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Registered tablets. Punches from unknown devices are rejected.
CREATE TABLE kiosk_device (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  name VARCHAR(100) NOT NULL,
  token_hash CHAR(64) NOT NULL,            -- device token shown once at registration
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  registered_by_user_id INTEGER NOT NULL REFERENCES user_account(id),
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Employee and Contract Tables

```sql
-- employee = ONE EMPLOYMENT at ONE company. Vacation entitlement and the time account belong to
-- the employee row, not to a hotel. Contract terms live in employee_contract (effective-dated).
CREATE TABLE employee (
  employee_id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user_account(id),  -- created automatically at onboarding
  company_id INTEGER NOT NULL REFERENCES company(id),
  primary_hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  primary_department_id INTEGER NOT NULL REFERENCES department(id),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  display_name VARCHAR(110) GENERATED ALWAYS AS (first_name || ' ' || left(last_name, 1) || '.') STORED,
  date_of_birth DATE NOT NULL,                           -- drives minor protection (under 18)
  work_time_protection VARCHAR(12) NOT NULL DEFAULT 'none' CHECK (work_time_protection IN ('none','maternity')),
                                                         -- admin/super admin only; no health detail stored
  preferred_language VARCHAR(5) NOT NULL DEFAULT 'de',
  contact_email VARCHAR(255),                            -- for invitation; optional
  phone VARCHAR(40),                                     -- optional; managers see it only if company.managers_can_see_phone
  badge_hash CHAR(64),                                   -- optional NFC/QR badge (hashed); never biometrics
  is_floater BOOLEAN NOT NULL DEFAULT FALSE,             -- may cover shifts at other hotels
  pin_hash VARCHAR(255) NOT NULL,                        -- argon2id/bcrypt; verified only AFTER the employee is selected
  pin_set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pin_failed_count INTEGER NOT NULL DEFAULT 0,
  pin_locked_until TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'active',          -- active, inactive (account activation is tracked on user_account)
  contract_start_date DATE NOT NULL,
  contract_end_date DATE,
  created_by_id INTEGER NOT NULL REFERENCES admin(admin_id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, company_id)
);

CREATE TABLE employee_contract (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  valid_from DATE NOT NULL,
  valid_to DATE,                                         -- NULL = open ended
  employment_type VARCHAR(20) NOT NULL
    CHECK (employment_type IN ('full_time','part_time','minijob','werkstudent','apprentice','short_term','other')),
  working_model VARCHAR(20) NOT NULL CHECK (working_model IN ('hourly','salary')),
  work_days_per_week SMALLINT NOT NULL CHECK (work_days_per_week BETWEEN 1 AND 7),
  target_hours_per_week DECIMAL(6,2),                    -- nullable
  target_hours_per_month DECIMAL(6,2),                   -- nullable
  daily_target_hours DECIMAL(5,2),                       -- derived: weekly / work_days_per_week
  vacation_days_per_year DECIMAL(4,1) NOT NULL,          -- total = statutory + contractual (+ statutory extras, reason not stored)
  carryover_limit_days DECIMAL(4,1) NOT NULL DEFAULT 0,  -- caps CONTRACTUAL days only
  rest_vacation_days_per_year DECIMAL(4,1),
  gets_public_holiday BOOLEAN NOT NULL DEFAULT FALSE,
  monthly_hours_cap DECIMAL(6,2),                        -- optional, e.g. minijob hours limit set by admin
  account_min_hours DECIMAL(6,2),                        -- optional floor for arbeitszeitkonto (negative)
  account_max_hours DECIMAL(6,2),                        -- optional ceiling for arbeitszeitkonto
  created_by_id INTEGER NOT NULL REFERENCES admin(admin_id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  EXCLUDE USING gist (employee_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&)
);
```

### Join Tables

```sql
CREATE TABLE admin_company (
  admin_id INTEGER NOT NULL REFERENCES admin(admin_id),
  company_id INTEGER NOT NULL REFERENCES company(id),
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  assigned_by_id INTEGER NOT NULL REFERENCES super_admin(super_admin_id),
  PRIMARY KEY (admin_id, company_id)
);

CREATE TABLE manager_hotel (
  manager_id INTEGER NOT NULL REFERENCES manager(manager_id),
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  PRIMARY KEY (manager_id, hotel_id)
);

-- primary_hotel_id must also exist here
CREATE TABLE employee_hotel (
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  PRIMARY KEY (employee_id, hotel_id)
);

CREATE TABLE employee_department (
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  department_id INTEGER NOT NULL REFERENCES department(id),
  PRIMARY KEY (employee_id, department_id)
);
```

### Shift & Scheduling

```sql
-- Template only. Real start/end/duration always come from schedule timestamps.
CREATE TABLE shift (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  department_id INTEGER NOT NULL REFERENCES department(id),
  name VARCHAR(100) NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,                  -- end_time <= start_time means the shift ends the next day
  break_duration_minutes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Several rows per employee per day are allowed (split shifts, e.g. breakfast + dinner).
-- Overlaps are blocked across ALL hotels of the employee by the exclusion constraint.
-- shift_date = local START date of the shift.
CREATE TABLE schedule (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  shift_id INTEGER REFERENCES shift(id),   -- NULL for ad-hoc entries
  shift_date DATE NOT NULL,
  planned_start TIMESTAMPTZ NOT NULL,
  planned_end TIMESTAMPTZ NOT NULL,
  planned_break_minutes INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled')),
  published_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,       -- optimistic locking for the planning grid
  cancel_reason VARCHAR(20) CHECK (cancel_reason IN ('sick','changed','other')),  -- set when status = 'cancelled'
  time_off_id INTEGER,                     -- FK added below (sick entry that replaced this shift)
  created_by_user_id INTEGER NOT NULL REFERENCES user_account(id),   -- super admin, admin or manager
  created_by_role VARCHAR(12) NOT NULL CHECK (created_by_role IN ('super_admin','admin','manager')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (planned_end > planned_start),
  EXCLUDE USING gist (employee_id WITH =, tstzrange(planned_start, planned_end) WITH &&)
    WHERE (status <> 'cancelled')
);
CREATE INDEX idx_schedule_hotel_date ON schedule (hotel_id, shift_date);

-- Required headcount per shift. Date override beats weekday default; no row = no requirement.
CREATE TABLE shift_staffing_requirement (
  id SERIAL PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shift(id),
  weekday SMALLINT CHECK (weekday BETWEEN 1 AND 7),     -- 1 = Monday
  on_date DATE,
  required_headcount INTEGER NOT NULL CHECK (required_headcount >= 0),
  CHECK ((weekday IS NOT NULL) <> (on_date IS NOT NULL))
);
CREATE UNIQUE INDEX uq_staffing_weekday ON shift_staffing_requirement (shift_id, weekday) WHERE weekday IS NOT NULL;
CREATE UNIQUE INDEX uq_staffing_date ON shift_staffing_requirement (shift_id, on_date) WHERE on_date IS NOT NULL;
```

### Time & Attendance

```sql
-- The ACTUAL punch times are the legal record and are never overwritten.
-- Paid times (after grace period / approved adjustments) are stored separately.
CREATE TABLE punch_record (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  schedule_id INTEGER REFERENCES schedule(id),           -- NULL = unplanned work
  is_unplanned BOOLEAN NOT NULL DEFAULT FALSE,
  shift_date DATE NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'kiosk'
    CHECK (source IN ('kiosk','kiosk_offline','web','manual','correction','auto_checkout')),
  kiosk_device_id INTEGER REFERENCES kiosk_device(id),
  planned_start TIMESTAMPTZ,
  planned_end TIMESTAMPTZ,
  actual_punch_in TIMESTAMPTZ NOT NULL,                  -- server time
  actual_punch_out TIMESTAMPTZ,
  paid_start TIMESTAMPTZ,                                -- after grace period / approval
  paid_end TIMESTAMPTZ,
  start_variation_minutes INTEGER,
  end_variation_minutes INTEGER,
  required_break_minutes INTEGER,
  actual_break_minutes INTEGER,
  break_segments JSONB,                                  -- optional [{start,end}], each >= 15 min
  paid_hours DECIMAL(5,2),
  under_break_warning BOOLEAN NOT NULL DEFAULT FALSE,
  auto_checked_out BOOLEAN NOT NULL DEFAULT FALSE,
  offline_punch BOOLEAN NOT NULL DEFAULT FALSE,
  approval_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending','approved','rejected')),
  approval_source VARCHAR(10) CHECK (approval_source IN ('auto','manual')),
  approved_by_user_id INTEGER REFERENCES user_account(id),
  approved_by_role VARCHAR(12) CHECK (approved_by_role IN ('super_admin','admin','manager')),
  approved_at TIMESTAMPTZ,
  approval_notes TEXT,
  created_by_user_id INTEGER REFERENCES user_account(id), -- set for manual/correction entries
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (actual_punch_out IS NULL OR actual_punch_out > actual_punch_in)
);
CREATE INDEX idx_punch_employee_date ON punch_record (employee_id, shift_date);
-- one open punch per employee
CREATE UNIQUE INDEX uq_punch_open ON punch_record (employee_id) WHERE actual_punch_out IS NULL;

-- Every change to a punch record (who, when, old/new) - visible to the employee
CREATE TABLE punch_record_history (
  id SERIAL PRIMARY KEY,
  punch_record_id INTEGER NOT NULL REFERENCES punch_record(id),
  changed_by_user_id INTEGER REFERENCES user_account(id),
  changed_by_role VARCHAR(12),
  change_type VARCHAR(30) NOT NULL,
  old_values JSONB,
  new_values JSONB,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE time_variation (
  id SERIAL PRIMARY KEY,
  punch_record_id INTEGER NOT NULL REFERENCES punch_record(id),
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  variation_type VARCHAR(20) NOT NULL
    CHECK (variation_type IN ('clock_in_early','clock_in_late','clock_out_early','clock_out_late','unplanned')),
  planned_time TIMESTAMPTZ,
  actual_time TIMESTAMPTZ NOT NULL,
  variation_minutes INTEGER,
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',   -- pending, approved, rejected
  reviewed_by_user_id INTEGER REFERENCES user_account(id),
  reviewed_by_role VARCHAR(12) CHECK (reviewed_by_role IN ('super_admin','admin','manager')),
  review_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Employee asks to add or fix a punch (forgot to clock in/out, wrong time)
CREATE TABLE time_correction_request (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  punch_record_id INTEGER REFERENCES punch_record(id),   -- NULL when adding a missing record
  correction_type VARCHAR(15) NOT NULL CHECK (correction_type IN ('missed_in','missed_out','wrong_time','missing_day')),
  requested_in TIMESTAMPTZ,
  requested_out TIMESTAMPTZ,
  requested_break_minutes INTEGER,
  reason TEXT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by_user_id INTEGER REFERENCES user_account(id),
  decided_by_role VARCHAR(12),
  decision_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);

-- Denormalised read model for manager reports
CREATE TABLE attendance_tracking (
  id SERIAL PRIMARY KEY,
  punch_record_id INTEGER UNIQUE NOT NULL REFERENCES punch_record(id),
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  shift_date DATE NOT NULL,
  planned_start TIMESTAMPTZ, planned_end TIMESTAMPTZ,
  actual_start TIMESTAMPTZ,  actual_end TIMESTAMPTZ,
  start_variation_minutes INTEGER, end_variation_minutes INTEGER,
  within_grace_period BOOLEAN,
  paid_hours DECIMAL(5,2),
  required_break_minutes INTEGER, actual_break_minutes INTEGER,
  under_break_warning BOOLEAN,
  auto_checked_out BOOLEAN,
  variation_status VARCHAR(20),
  approval_status VARCHAR(20),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_attendance_hotel_date ON attendance_tracking (hotel_id, shift_date);
CREATE INDEX idx_attendance_employee_date ON attendance_tracking (employee_id, shift_date);

-- Month-end lock. After close, changes only via logged corrections by admin/super admin.
CREATE TABLE payroll_period (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company(id),
  hotel_id INTEGER REFERENCES hotel(id),                 -- NULL = whole company
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_by_user_id INTEGER REFERENCES user_account(id),
  closed_at TIMESTAMPTZ,
  reopened_by_user_id INTEGER REFERENCES user_account(id),
  reopen_reason TEXT
);
```

### Vacation, Absence & Time Account

```sql
-- One row per employee and year (NOT per hotel)
CREATE TABLE employee_vacation_allowance (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  year INTEGER NOT NULL,
  vacation_days_total DECIMAL(4,1) NOT NULL,             -- contract value for the year
  statutory_days DECIMAL(4,1) NOT NULL,                  -- MIN(total, 4 x work_days_per_week)
  contractual_days DECIMAL(4,1) NOT NULL,                -- total - statutory
  allocated_days DECIMAL(4,1) NOT NULL,                  -- after BUrlG proration or admin override
  used_days DECIMAL(4,1) NOT NULL DEFAULT 0,
  carried_statutory_days DECIMAL(4,1) NOT NULL DEFAULT 0,
  carried_contractual_days DECIMAL(4,1) NOT NULL DEFAULT 0,
  carryover_expires_on DATE,                             -- March 31 (only effective if notices were sent)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (employee_id, year)
);

-- Proof that the employer informed the employee about leave and expiry (BAG/EuGH duty)
CREATE TABLE vacation_notice (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  year INTEGER NOT NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('initial','reminder','final')),
  remaining_days DECIMAL(4,1) NOT NULL,
  channel VARCHAR(10) NOT NULL CHECK (channel IN ('email','in_app','print')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ
);

-- Absence types (system table; flags drive credits, targets and allowance)
CREATE TABLE absence_type (
  code VARCHAR(30) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  counts_against_allowance BOOLEAN NOT NULL DEFAULT FALSE,
  credits_hours BOOLEAN NOT NULL DEFAULT FALSE,     -- adds the daily target to the time account
  reduces_target BOOLEAN NOT NULL DEFAULT FALSE,    -- lowers the monthly target (unpaid absences)
  requires_certificate BOOLEAN NOT NULL DEFAULT FALSE,
  salary_only BOOLEAN NOT NULL DEFAULT FALSE,       -- only for employees with a time account
  primary_menu BOOLEAN NOT NULL DEFAULT FALSE       -- shown directly in the grid + menu (others under "More")
);
INSERT INTO absence_type
 (code, name, counts_against_allowance, credits_hours, reduces_target, requires_certificate, salary_only, primary_menu) VALUES
 ('annual_leave','Vacation',TRUE,TRUE,FALSE,FALSE,FALSE,TRUE),
 ('sick_leave','Sick leave',FALSE,TRUE,FALSE,TRUE,FALSE,TRUE),
 ('off_day','Free day',FALSE,FALSE,FALSE,FALSE,FALSE,TRUE),
 ('unpaid_leave','Unpaid day off',FALSE,FALSE,TRUE,FALSE,FALSE,TRUE),
 ('comp_time','Time off in lieu (Zeitausgleich)',FALSE,FALSE,FALSE,FALSE,TRUE,FALSE),
 ('special_leave','Special leave (paid)',FALSE,TRUE,FALSE,FALSE,FALSE,FALSE),
 ('child_sick','Child sick',FALSE,FALSE,TRUE,FALSE,FALSE,FALSE),
 ('training','Training',FALSE,TRUE,FALSE,FALSE,FALSE,FALSE),
 ('parental_leave','Parental leave (Elternzeit)',FALSE,FALSE,TRUE,FALSE,FALSE,FALSE),
 ('maternity_leave','Maternity protection (Mutterschutz)',FALSE,FALSE,TRUE,FALSE,FALSE,FALSE),
 ('rest_day','Replacement rest day',FALSE,FALSE,FALSE,FALSE,FALSE,FALSE),
 ('public_holiday','Public holiday',FALSE,TRUE,FALSE,FALSE,FALSE,FALSE);

CREATE TABLE time_off (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  half_day VARCHAR(10) CHECK (half_day IN ('morning','afternoon')),   -- single-day half days
  time_off_days DECIMAL(4,1) NOT NULL,                   -- counts only the employee's working days, excludes public holidays
  type VARCHAR(30) NOT NULL REFERENCES absence_type(code),
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, approved, rejected, cancelled
  certificate_status VARCHAR(15) CHECK (certificate_status IN ('not_required','pending','received')),  -- sick leave
  backdate_override_reason TEXT,
  counts_against_allowance BOOLEAN NOT NULL,
  credits_hours BOOLEAN NOT NULL DEFAULT FALSE,          -- TRUE for annual_leave, sick_leave, public_holiday (salary workers)
  created_by_user_id INTEGER NOT NULL REFERENCES user_account(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (end_date >= start_date)
);
ALTER TABLE schedule ADD CONSTRAINT fk_schedule_time_off FOREIGN KEY (time_off_id) REFERENCES time_off(id);

-- Salary workers only. The ledger is the truth; arbeitszeitkonto is a cached balance.
CREATE TABLE arbeitszeitkonto (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER UNIQUE NOT NULL REFERENCES employee(employee_id),
  balance_hours DECIMAL(8,2) NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE arbeitszeitkonto_entry (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  entry_date DATE NOT NULL,
  entry_type VARCHAR(20) NOT NULL
    CHECK (entry_type IN ('worked','absence_credit','target','correction','payout','opening_balance')),
  hours DECIMAL(6,2) NOT NULL,                           -- signed: target is negative
  source_type VARCHAR(30),
  source_id INTEGER,
  note TEXT,
  created_by_user_id INTEGER REFERENCES user_account(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_azk_entry_employee ON arbeitszeitkonto_entry (employee_id, entry_date);
```

### Wishes

```sql
CREATE TABLE employee_shift_wish (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  date DATE NOT NULL,
  shift_id INTEGER NOT NULL REFERENCES shift(id),
  priority INTEGER NOT NULL,  -- 1=high, 2=medium, 3=low
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE employee_leave_wish (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  leave_days DECIMAL(4,1) NOT NULL,
  priority INTEGER NOT NULL,
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Public Holidays, Imports, Notifications & Audit

```sql
-- Scopes: national, state, company, hotel. Resolution for a hotel on a date: hotel > company > state > national.
CREATE TABLE public_holiday (
  id SERIAL PRIMARY KEY,
  scope VARCHAR(10) NOT NULL CHECK (scope IN ('national','state','company','hotel')),
  federal_state VARCHAR(2),
  company_id INTEGER REFERENCES company(id),
  hotel_id INTEGER REFERENCES hotel(id),
  date DATE NOT NULL,
  name VARCHAR(100) NOT NULL,
  is_holiday BOOLEAN NOT NULL DEFAULT TRUE,   -- FALSE lets a company/hotel cancel an inherited holiday
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_holiday_scope ON public_holiday
  (scope, COALESCE(federal_state,''), COALESCE(company_id,0), COALESCE(hotel_id,0), date);

CREATE TABLE import_job (
  id SERIAL PRIMARY KEY,
  import_type VARCHAR(30) NOT NULL DEFAULT 'employees',
  admin_id INTEGER NOT NULL REFERENCES admin(admin_id),
  status VARCHAR(20) NOT NULL DEFAULT 'queued',  -- queued, running, done, failed, awaiting_conflicts
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  on_duplicate_email VARCHAR(10) NOT NULL DEFAULT 'skip',
  total_rows INTEGER, created_count INTEGER, updated_count INTEGER, skipped_count INTEGER, error_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE export_job (
  id SERIAL PRIMARY KEY,
  requested_by_user_id INTEGER NOT NULL REFERENCES user_account(id),
  requested_by_role VARCHAR(12) NOT NULL,
  export_type VARCHAR(40) NOT NULL,
  format VARCHAR(10) NOT NULL,
  filters JSONB,
  status VARCHAR(10) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','expired')),
  row_count INTEGER,
  file_ref VARCHAR(255),                   -- encrypted storage reference
  expires_at TIMESTAMPTZ,                  -- download for 24 h, deleted after 7 days
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE calendar_feed (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  token_hash CHAR(64) NOT NULL UNIQUE,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE notification (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user_account(id),
  employee_id INTEGER REFERENCES employee(employee_id),
  kind VARCHAR(30) NOT NULL,   -- schedule_published, schedule_changed, approval_decision, vacation_notice, ...
  payload JSONB,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Append-only. The application role gets INSERT and SELECT only (REVOKE UPDATE, DELETE).
-- entry_hash = SHA-256(previous entry_hash || row content) makes tampering detectable.
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES company(id),
  hotel_id INTEGER REFERENCES hotel(id),
  actor_id INTEGER,
  actor_type VARCHAR(20),  -- super_admin, admin, manager, employee, system
  action VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50),
  entity_id INTEGER,
  old_values JSONB,
  new_values JSONB,
  reason TEXT,
  status VARCHAR(20),
  ip_address VARCHAR(45),
  user_agent TEXT,
  entry_hash CHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_hotel_created ON audit_log (hotel_id, created_at);
CREATE INDEX idx_audit_actor_created ON audit_log (actor_id, created_at);
```

### Additional Tables (v3.3)

```sql
-- Hour categories: configurable windows that produce payroll-ready minutes (night, Sunday, holiday,
-- 24 Dec / 31 Dec from 14:00, custom). No wage calculation.
CREATE TABLE hour_category (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES company(id),             -- NULL = system default
  code VARCHAR(30) NOT NULL,
  name VARCHAR(100) NOT NULL,
  rule JSONB NOT NULL,   -- {"daily":{"from":"23:00","to":"06:00"}} | {"weekday":7} | {"holiday":true} | {"dates":["12-24","12-31"],"from":"14:00","to":"24:00"}
  UNIQUE (company_id, code)
);

CREATE TABLE punch_record_category_minutes (
  punch_record_id INTEGER NOT NULL REFERENCES punch_record(id),
  category_code VARCHAR(30) NOT NULL,
  minutes INTEGER NOT NULL,
  PRIMARY KEY (punch_record_id, category_code)
);

-- Managers limited to departments (no rows = all departments of the assigned hotels)
CREATE TABLE manager_department (
  manager_id INTEGER NOT NULL REFERENCES manager(manager_id),
  department_id INTEGER NOT NULL REFERENCES department(id),
  PRIMARY KEY (manager_id, department_id)
);

-- Vacation blackout periods and minimum staffing for absences
CREATE TABLE absence_blackout (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  department_id INTEGER REFERENCES department(id),
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  reason VARCHAR(200),
  max_concurrent_absent INTEGER,                         -- NULL = no vacation allowed in this period
  created_by_user_id INTEGER NOT NULL REFERENCES user_account(id),
  CHECK (to_date >= from_date)
);

-- Qualifications (e.g. first aider, night porter, hygiene instruction) with expiry
CREATE TABLE qualification (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company(id),
  name VARCHAR(100) NOT NULL,
  has_expiry BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE employee_qualification (
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  qualification_id INTEGER NOT NULL REFERENCES qualification(id),
  valid_until DATE,
  PRIMARY KEY (employee_id, qualification_id)
);
ALTER TABLE shift ADD COLUMN required_qualification_id INTEGER REFERENCES qualification(id);

-- Personnel documents (no health data). Encrypted storage, expiry reminders.
CREATE TABLE employee_document (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  doc_type VARCHAR(30) NOT NULL
    CHECK (doc_type IN ('contract','hygiene_instruction','work_permit','training_certificate','payslip','other')),
  title VARCHAR(200) NOT NULL,
  file_ref VARCHAR(255) NOT NULL,
  valid_until DATE,
  visible_to_employee BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_by_user_id INTEGER NOT NULL REFERENCES user_account(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Availability: recurring times an employee cannot or prefers to work
CREATE TABLE employee_availability (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  from_time TIME NOT NULL,
  to_time TIME NOT NULL,
  kind VARCHAR(12) NOT NULL CHECK (kind IN ('unavailable','preferred')),
  valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_to DATE,
  note VARCHAR(200)
);

-- Shift swaps and giveaways between employees (manager approves)
CREATE TABLE shift_swap_request (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  schedule_id INTEGER NOT NULL REFERENCES schedule(id),              -- the shift being given away
  requester_employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  counterpart_employee_id INTEGER REFERENCES employee(employee_id),  -- NULL = offered to anyone eligible
  counterpart_schedule_id INTEGER REFERENCES schedule(id),           -- set for a 1:1 swap, NULL for a giveaway
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','accepted_by_peer','approved','rejected','cancelled','expired')),
  reason VARCHAR(300),
  decided_by_user_id INTEGER REFERENCES user_account(id),
  decided_by_role VARCHAR(12),
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Open shifts that employees may apply for
CREATE TABLE open_shift (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  department_id INTEGER NOT NULL REFERENCES department(id),
  shift_id INTEGER REFERENCES shift(id),
  shift_date DATE NOT NULL,
  planned_start TIMESTAMPTZ NOT NULL,
  planned_end TIMESTAMPTZ NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','cancelled')),
  filled_schedule_id INTEGER REFERENCES schedule(id),
  created_by_user_id INTEGER NOT NULL REFERENCES user_account(id),
  created_by_role VARCHAR(12) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (planned_end > planned_start)
);
CREATE TABLE open_shift_claim (
  id SERIAL PRIMARY KEY,
  open_shift_id INTEGER NOT NULL REFERENCES open_shift(id),
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  decided_by_user_id INTEGER REFERENCES user_account(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (open_shift_id, employee_id)
);

-- Announcements with optional read confirmation
CREATE TABLE announcement (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company(id),
  hotel_id INTEGER REFERENCES hotel(id),                 -- NULL = whole company
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  requires_ack BOOLEAN NOT NULL DEFAULT FALSE,
  publish_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id INTEGER NOT NULL REFERENCES user_account(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE announcement_ack (
  announcement_id INTEGER NOT NULL REFERENCES announcement(id),
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (announcement_id, employee_id)
);

-- Phase 9 (optional): occupancy-based staffing suggestions
CREATE TABLE occupancy_forecast (
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  forecast_date DATE NOT NULL,
  occupied_rooms INTEGER NOT NULL,
  arrivals INTEGER,
  departures INTEGER,
  source VARCHAR(30),
  imported_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (hotel_id, forecast_date)
);
CREATE TABLE staffing_rule (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  department_id INTEGER NOT NULL REFERENCES department(id),
  shift_id INTEGER NOT NULL REFERENCES shift(id),
  driver VARCHAR(20) NOT NULL CHECK (driver IN ('occupied_rooms','arrivals','departures')),
  units_per_employee DECIMAL(6,2) NOT NULL CHECK (units_per_employee > 0),
  min_headcount INTEGER NOT NULL DEFAULT 0
);
```

### Tenant isolation

Enable PostgreSQL row-level security on every table that carries `company_id` (directly or via hotel/employee). The API sets `SET LOCAL app.allowed_company_ids` and `app.allowed_hotel_ids` per request from the active role, so a missing WHERE clause cannot leak another company's data.

---

## API Endpoints (Phase 1)

### Authentication

**POST /auth/login**
- Input: email, password
- Output: access_token (15 min), refresh_token (7 days, httpOnly cookie)

**POST /auth/refresh**
- Input: refresh_token (from cookie)
- Output: new access_token

**POST /auth/logout**
- Invalidates refresh token

---

### Admin: Employee Management

**POST /admin/employees** — Create employee with employment terms
- Request: firstName, lastName, email, primaryHotelId, primaryDepartmentId, workingModel, contractStartDate, contractEndDate, targetHoursPerWeek, targetHoursPerMonth, vacationDaysPerYear, vacationDaysAllocatedThisYear, vacationDaysUsedThisYear, restVacationDaysPerYear, getsPublicHoliday, arbeitszeitkontoBalance
- Response: employeeId, personalNumber, status, invitationExpiresAt, all employment terms
- Creates: EMPLOYEE, EMPLOYEE_VACATION_ALLOWANCE, ARBEITSZEITKONTO (if salary)

**GET /admin/employees/:id** — Get employee profile
- Response: Full employee data (personal + employment terms)

**PUT /admin/employees/:id** — Update employee
- Input: Updatable fields (contract dates, vacation allocation, work targets, etc.)
- Response: Updated employee

**GET /admin/employees?companyId=:id** — List employees in assigned companies
- Response: Array of employees with basic info

---

### Manager: Shifts & Scheduling

**POST /manager/shifts** — Create shift template
- Input: hotelId, departmentId, name, startTime, endTime, breakDurationMinutes
- Response: shiftId, paidHours (calculated)

**GET /manager/shifts?hotelId=:id** — List shifts for assigned hotel
- Response: Array of shifts

**POST /manager/schedule** — Assign shift to employee
- Input: hotelId, employeeId, shiftId, date, startTimeOverride (optional), endTimeOverride (optional)
- Response: scheduleId, paidHoursAssigned, currentWeekHours, currentMonthHours, weeklyTarget, monthlyTarget, restPeriodHours, warnings[]
- Validations (Hard Blocks): Double-booking, time-off conflict, department mismatch, past date
- Warnings (Soft): Rest period < 11h, hours below/above target, exceeding max hours (all logged to audit)

**GET /manager/schedule?hotelId=:id&date=:date** — Get schedule grid for date
- Response: [{ employeeId, shiftId, paidHours, startTime, endTime }]

**GET /manager/employees/:id/hours?week=:week&month=:month** — Get employee hours summary
- Response: currentWeekHours, currentMonthHours, weeklyTarget, monthlyTarget, weeklyBreakdown (day by day)

---

### Employee: Self-Service

**GET /employee/me** — Get own profile
- Response: firstName, lastName, email, status, workingModel, contractDates, targets (if any), vacation info

**GET /employee/me/schedule?month=:month** — Get own schedule
- Response: Array of assigned shifts with dates/times

**GET /employee/me/hours** — Get own hours summary
- Response: currentWeekHours, currentMonthHours, weeklyTarget, monthlyTarget, weeklyBreakdown

**GET /employee/me/vacation** — Get vacation balance
- Response: vacationDaysPerYear, vacationDaysAllocatedThisYear, vacationDaysUsedThisYear, remainingVacationDays

**GET /employee/me/arbeitszeitkonto** — Get overtime account (salary workers only)
- Response: balanceHours, interpretation, lastUpdated

**POST /employee/punch** — Clock in/out (with grace period & time variation handling)
- Input: personalNumber (PIN), action (in/out), timestamp, [reason (optional, if outside grace period)]
- Response: punchId, message, balance, [timeVariationRequired (boolean), timeVariationId (if created)]
- Validations: PIN must match employee, not already clocked in/out
- Grace period logic:
  - Compare actual time vs planned shift start/end time
  - If difference ≤ 15 minutes: Use planned time, no reason needed, no variation record
  - If difference > 15 minutes: Ask for reason, create TIME_VARIATION record (status: pending), use actual time
- Response includes: timeVariationStatus (if applicable), plannedTime, actualTime, variationMinutes

**POST /employee/time-off-request** — Request time-off
- Input: startDate, endDate, type (annual_leave/unpaid_leave), reason
- Response: requestId, status (pending)
- Validations: If annual_leave, check remaining vacation days

**POST /employee/shift-wish** — Request shift
- Input: date, shiftId, priority, reason
- Response: wishId, status (pending)

**POST /employee/leave-wish** — Request leave
- Input: startDate, endDate, leaveDays, priority, reason
- Response: wishId, status (pending)

---

### Manager: Approvals

**GET /manager/time-off-requests?hotelId=:id&status=pending** — List pending approvals
- Response: Array of time-off requests

**PUT /manager/time-off-requests/:id** — Approve/reject time-off
- Input: status (approved/rejected), notes
- Response: Updated request
- Side effect (if approved & annual_leave): Deduct from vacation_days_used_this_year

**GET /manager/shift-wishes?hotelId=:id&status=pending** — List pending shift wishes
- Response: Array of shift wishes

**PUT /manager/shift-wishes/:id** — Approve/reject wish
- Input: status (approved/rejected), notes
- Response: Updated wish
- Side effect (if approved): Create schedule record if no conflict

**POST /manager/employees/:id/sick-leave** — Assign sick leave
- Input: startDate, daysCount, reason
- Validations: Can backdate max 7 days (startDate >= TODAY() - 7 days)
- Response: timeOffId
- Side effect: Create time_off record (counts_against_allowance=false, counts_as_working_hours=false)

**GET /manager/time-variations?hotelId=:id&status=pending** — List pending time variations
- Query params: hotelId, status (pending/approved/rejected), days (default: 7)
- Response: Array of time variations with employee name, date, shift, planned vs actual times, deviation minutes, reason, employee notes
- Sortable by: date, employee, variation minutes

**PUT /manager/time-variations/:id** — Approve/reject time variation
- Input: status (approved/rejected), reviewNotes (optional: manager's decision comment)
- Response: Updated time variation record
- Side effects (if approved):
  - Update PUNCH_RECORD with actual times
  - Recalculate shift_duration_minutes and paid_hours
  - Audit log entry
- Side effects (if rejected):
  - PUNCH_RECORD uses planned times only
  - Audit log entry with rejection reason

**GET /manager/auto-checkouts?hotelId=:id&status=pending** — List pending auto-checkouts (forgotten clock-outs)
- Query params: hotelId, status (pending/reviewed), days (default: 7)
- Response: Array of auto-checkouts with employee name, date, planned end time, auto-checkout time, calculated duration
- Shows: Employee alert status, manager review status

**PUT /manager/auto-checkouts/:id** — Adjust/approve auto-checkout
- Input: adjustedCheckoutTime (optional: manager can change the auto-checkout time), status (reviewed/approved), notes (optional)
- Response: Updated PUNCH_RECORD with new times/hours
- Side effects:
  - If adjustedCheckoutTime provided: recalculate shift_duration_minutes, paid_hours, break requirement
  - Set auto_checkout_reviewed = TRUE
  - Audit log entry with manager name and reason
  - Send notification to employee with manager's decision

**GET /manager/audit-log?hotelId=:id&days=30** — View audit log
- Response: Array of audit log entries (actions, timestamps, actors, details)

---

### Manager: Attendance Tracking & Reporting

**GET /manager/attendance-tracking?hotelId=:id&startDate=:date&endDate=:date** — View all punch records with variations
- Query params: hotelId, startDate, endDate, employeeId (optional), status (all/late/early/on-time)
- Response: Array of attendance records with:
  - Employee ID, shift date, planned vs actual times
  - Clock-in/out variations (in minutes)
  - Within grace period flags
  - Paid hours, break info, under-break warnings
  - Auto-checkout flag, time variation status
- Default period: last 7 days
- Sortable by: date, employee, variation minutes, paid hours

**GET /manager/attendance-summary?hotelId=:id&employeeId=:id&startDate=:date&endDate=:date** — Employee attendance pattern analysis
- Response:
  ```json
  {
    "employeeId": 123,
    "employeeName": "John S.",
    "analysisPeriod": "2026-09-01 to 2026-10-04",
    "totalShifts": 30,
    "statistics": {
      "onTimeCount": 24,
      "lateCount": 4,
      "earlyCount": 2,
      "averageClockInVariation": "+2.1 min",
      "averageClockOutVariation": "-1.3 min",
      "latePattern": "Mondays & Tuesdays mostly",
      "autoCheckoutCount": 1,
      "underBreakViolations": 2
    },
    "recentIssues": [
      {
        "date": "2026-10-04",
        "type": "under_break_warning",
        "details": "Took 15 min break instead of required 30 min"
      },
      {
        "date": "2026-10-03",
        "type": "clock_in_late",
        "details": "Clocked in 22 min late (outside 15 min grace period)"
      }
    ]
  }
  ```
- Analysis includes: on-time %, late %, early %, patterns, warnings

**GET /manager/late-arrivals?hotelId=:id&days=30** — Quick view of late arrivals (outside grace period)
- Query params: hotelId, days (default: 30), minVariationMinutes (default: 16)
- Response: Array of late clock-ins with:
  - Employee name, date, planned time, actual time, minutes late
  - Whether variation is pending/approved/rejected
  - Reason provided by employee
- Sorted by date (most recent first)

**GET /manager/early-departures?hotelId=:id&days=30** — Quick view of early departures (outside grace period)
- Query params: hotelId, days (default: 30), minVariationMinutes (default: 16)
- Response: Array of early clock-outs with:
  - Employee name, date, planned end time, actual end time, minutes early
  - Whether variation is pending/approved/rejected
  - Reason provided by employee
- Sorted by date (most recent first)

**GET /manager/under-break-violations?hotelId=:id&days=30** — Break compliance report
- Query params: hotelId, days (default: 30)
- Response: Array of shifts with insufficient breaks:
  - Employee name, date, shift duration, required break, actual break, shortfall minutes
  - Employee's break reason (if provided)
  - Manager's adjustment status
- Sorted by violation severity (greatest shortfall first)

**GET /manager/auto-checkout-history?hotelId=:id&days=30** — Auto-checkout audit trail
- Query params: hotelId, days (default: 30), status (pending/reviewed/approved)
- Response: Array of auto-checkouts:
  - Employee name, date, planned shift end, auto-checkout time
  - Manager review status, adjusted time (if any), manager notes
  - Employee notification status
- Sorted by date (most recent first)

---

## API Endpoints - Additions from Resolved Decisions

**Authorization scope (applies to every planning and approval endpoint)**

| Role | May plan shifts / approve worked time for |
|------|-------------------------------------------|
| SUPER_ADMIN | All hotels |
| ADMIN | Hotels of assigned companies |
| MANAGER | Hotels in `manager_hotel` |
| EMPLOYEE | Never |

Endpoints listed under `/manager/...` (shifts, schedule, time variations, auto-checkouts, attendance reports) are served by shared handlers for all three staff roles. They are also mounted under `/admin/...` with identical behaviour. The role resolver derives the allowed hotel set from the active role. Managers still see employee IDs and hours only; admins and super admins also see names. Self-approval is blocked: a person cannot plan around or approve their own worked time (relevant for dual-role users).

**Worked-time approval**
- `GET /approvals/worked-time?hotelId=:id&status=pending&from=:date&to=:date` -> punch records awaiting review (includes variation and auto-checkout flags)
- `PUT /approvals/worked-time/:punchRecordId` `{ "status": "approved|rejected", "adjustedPunchInTime"?, "adjustedPunchOutTime"?, "adjustedBreakMinutes"?, "notes"? }` -> sets approval fields, recalculates paid hours, writes audit log, updates `attendance_tracking`
- `POST /approvals/worked-time/bulk-approve` `{ "punchRecordIds": [..] }` -> approves clean records in one call (rejects ids outside the caller's scope with 403 per id)
- Time-variation and auto-checkout decisions (`PUT /manager/time-variations/:id`, `PUT /manager/auto-checkouts/:id`) also set the punch record's approval status.

**Hours visibility setting**
- `GET /admin/hotels/:id/settings` / `PUT /admin/hotels/:id/settings` `{ "employeeHoursVisibility": "immediately|after_approval" }` (admin, super admin only; audit-logged)
- `GET /employee/me/hours` and `GET /employee/me/attendance` honour the setting (see Business Rules).

**Shift planning**
- `POST /manager/shifts`, `POST /manager/schedule`, `PUT /manager/schedule/:id`, `DELETE /manager/schedule/:id` accept SUPER_ADMIN, ADMIN, MANAGER within scope. Stored as `created_by_user_id` + `created_by_role`. Same hard blocks and soft warnings for every role.

**Role selector (manager who is also an employee)**
- `POST /auth/login` -> returns `availableRoles` (e.g. `["manager","employee"]`); if only one, token is issued directly
- `POST /auth/select-role` `{ "role": "employee" }` -> access token carrying the active role
- `POST /auth/switch-role` -> new token for the other role (old token revoked)
- Every endpoint authorises against the ACTIVE role only; roles never combine permissions.

**PIN reset (admin only)**
- `POST /admin/employees/:id/reset-pin` -> generates a new PIN, invalidates the old one, shows it ONCE to the admin (printable slip), writes audit log. PINs are never emailed and admins can never read an existing PIN.

**Managers**
- `POST /admin/managers` (no hotel in body), `PUT /admin/managers/:id` with `hotelIds[]` (replaces manager_hotel rows)
- `GET /admin/managers/:id` returns `hotelIds[]`

**Public holidays**
- `GET /holidays?hotelId=:id&year=:y` -> resolved list (hotel > company > state > national)
- `POST /admin/holidays` `{scope, companyId?, hotelId?, federalState?, date, name, isHoliday}`; `DELETE /admin/holidays/:id`
- National + state holidays seeded per year; company/hotel rows only add or cancel.

**Vacation carryover**
- `GET /admin/vacation/carryover-preview?year=:y` -> per employee: unused days, limit, days to carry
- Year-end job runs Jan 1 (Europe/Berlin): carried = MIN(unused, carryover_limit_days); sets `carryover_expires_on` = Mar 31; audit-logged.

**v2.2 endpoint additions**

*Employment and contracts*
- `PUT /admin/employees/:id/contract` (new version with `validFrom`), `GET /admin/employees/:id/contracts`
- `POST /admin/employees/:id/resend-invitation` (email), `POST /admin/employees/:id/reset-activation` (new one-time code, shown once)
- `POST /admin/employees/:id/unlock-pin`, `POST /admin/employees/:id/reset-pin` (new PIN shown once to the admin, never emailed)
- `POST /admin/kiosk-devices` (token shown once), `GET /admin/kiosk-devices`, `DELETE /admin/kiosk-devices/:id`

*Rules and compliance*
- `GET|POST|PUT /admin/rule-profiles`, `PUT /admin/hotels/:id/rule-profile`
- `GET /manager/compliance-report?hotelId=:id&from=:date&to=:date` -> overrides, rest-period compensation status, Sunday count, night-worker flags
- Planning endpoints accept `overrideReason` (for `warn_reason` rules) and `emergencyOverride: true` (admin/super admin only, requires a reason; for `block_unless_emergency` rules)

*Schedule publishing*
- `POST /manager/schedule/publish` `{ hotelId, from, to }` -> status `published`, employees notified
- Changes after publishing notify the employee; changes inside `schedule_change_notice_days` are flagged in the compliance report
- Employees only ever see `published` rows

*Corrections, sickness on the plan, transparency*
- `POST /employee/time-corrections`, `GET /employee/time-corrections`; `GET /approvals/corrections?hotelId=:id&status=pending`, `PUT /approvals/corrections/:id` (manager, admin, super admin; creates or edits the punch record with `source = 'correction'` and history entry)
- Sickness is marked by planners on the plan: `POST /manager/schedule/absence` `{ employeeId, from, to, type, certificateStatus?, overrideReason? }` (`POST /manager/schedule/mark-sick` is an alias for `type: sick_leave`) (also under `/admin/...`; manager, admin, super admin). Works for past dates within the role's limit, cancels planned shifts in the range, creates the `sick_leave` entry, refunds overlapping vacation days when a certificate exists. `POST /manager/employees/:id/sick-leave` is an alias.
- `GET /employee/me/attendance/:punchRecordId/history`, `GET /employee/me/data-export`, `GET /employee/me/notifications`

*Vacation notices and periods*
- `GET /admin/vacation/notices?year=:y`, `POST /admin/vacation/notices/send`
- `GET /employee/me/vacation` additionally returns `carriedOverDays`, `carryoverExpiresOn`, `statutoryDays`, `contractualDays`
- `POST /admin/periods/close`, `POST /admin/periods/:id/reopen` (reason required), `GET /admin/periods`

*Payroll export (Phase 7)*
- `GET /admin/exports/payroll?companyId=:id&from=:date&to=:date&format=csv|datev` -> per employee and day: approved hours, night/Sunday/holiday minutes, absence types and days, time-account delta. Only closed periods; DATEV layout to be agreed with your tax adviser.

*Punch endpoint change*
- `POST /employee/punch` (web) is only available if `hotel.allow_web_punch = true`, uses the logged-in session (no PIN in the body) and stores `source = 'web'`.

*Role selector*
- `POST /auth/login` returns `availableRoles: [{ role, employeeId?, companyName }]`; a person with several employments or roles picks one, the token carries that role and employment.


---

## Business Rules

### Shift Planning & Assignment

**Hard Blocks (400/409 Conflict):**
1. Double-booking: Employee already assigned to another shift on same date
2. Time-off conflict: Approved time-off on that date
3. Department mismatch: Employee not assigned to shift's department
4. Past date: ordinary shifts cannot be assigned in the past. Exception: marking days as sick on the plan (managers up to `sick_backdate_days` back, default 7; admin/super admin any date with a reason)

**Soft Warnings (201 + warnings[]):**
1. Rest period < 11 hours: Gap between consecutive shifts
2. Hours below target: Cumulative hours this week/month < target
3. Hours above target: Cumulative hours this week/month > target
4. Exceeding max hours: Assignment would exceed max_hours_per_week or max_hours_per_month
5. All warnings logged to audit_log

**Manager Discretion:**
- Manager can override soft warnings and proceed with shift assignment
- Warnings are logged for audit trail + payroll review

### Paid Hours Calculation

```
paidHours = shiftDurationHours - (breakDurationMinutes / 60)

Example:
  Shift: 06:00 - 14:00 (8 hours)
  Break: 30 minutes
  Paid: 8 - 0.5 = 7.5 hours
```

- Paid hours used for all tracking: work targets, arbeitszeitkonto, summaries
- Breaks are unpaid
- Calculated on-the-fly, never stored in DB

### Time Variations & Grace Period

**Grace Period: 15 Minutes**

When an employee clocks in/out, the system checks if actual time is within 15 minutes of planned shift time:

- **Within grace period (≤ 15 min):** Use planned time, no reason needed, no variation record created
  - Planned 06:00 AM, clocks in 05:52 AM → Uses 06:00 AM (8 min early, within grace)
  - Planned 06:00 AM, clocks in 06:12 AM → Uses 06:00 AM (12 min late, within grace)

- **Outside grace period (> 15 min):** Capture reason, create TIME_VARIATION record, use actual time
  - Planned 06:00 AM, clocks in 05:40 AM → Asks "Why 20 min early?", uses 05:40 AM
  - Planned 15:00 PM, clocks out 15:25 PM → Asks "Why 25 min late?", uses 15:25 PM

**Time Variation Approval Workflow:**

1. **Employee Input:** Provides reason for early/late clock time
2. **Variation Record:** TIME_VARIATION created with status=pending
3. **Initial Calculation:** PUNCH_RECORD uses actual time for all calculations
4. **Manager Review:** Manager sees pending variations in dashboard
5. **Manager Action:**
   - **Approve:** TIME_VARIATION.status = approved, uses actual time in final hours
   - **Reject:** TIME_VARIATION.status = rejected, uses planned time, hours recalculated

**Important Notes:**
- Paid hours are recalculated based on approved times
- If variation is rejected, planned times are used instead
- All variations logged to audit trail
- Employees can see their pending variations and manager's decision

### Vacation Rules

**Annual Leave (annual_leave type):**
- Counts against vacation allowance
- Employee cannot exceed vacationDaysAllocatedThisYear
- On approval: deduct from vacation_days_used_this_year
- On rejection/cancellation: refund to vacation_days_used_this_year

**Sick Leave (sick_leave type):**
- Does NOT count against vacation allowance
- Can only be assigned by manager/admin (employees cannot self-request)
- Can backdate up to 7 days
- Direct assignment (no approval workflow)

**Other Types (unpaid_leave, off_day, rest_day, other):**
- Do NOT count against vacation allowance
- Tracked separately for audit

### Arbeitszeitkonto (Salary Workers Only)

**Enabled if:**
- workingModel = 'salary' AND target_hours_per_week OR target_hours_per_month is NOT null

**Disabled if:**
- workingModel = 'hourly' (ignored)
- BOTH target_hours_per_week AND target_hours_per_month are null

**Accumulation:**
```
balance_change = workedPaidHours - targetHours

Example:
  Target: 40 h/week
  Worked: 45 h
  Change: +5 hours (company owes employee)
  
Example:
  Target: 160 h/month
  Worked: 155 h
  Change: -5 hours (employee owes company)
```

**Public Holiday Bonus (if getsPublicHoliday=true):**
- If salaried and works on public holiday → hours added to arbeitszeitkonto
- Example: Works 8h on public holiday → +8h added

**Overtime Payments:**
- Admin can record overtime payments (moves hours from balance to payment history)
- Balance = accumulated_hours - hours_paid_out

---

### Resolved Rules (Oct 2026)

- **Worked-time approval:** records that need review (outside the 15-minute grace period, auto-checkout, under-break) stay `pending` until a manager, admin or super admin decides. Clean records (inside grace, break compliant, not auto-checkout) are auto-approved with `approval_source = auto`. Rejection reverts to planned times, as for time variations. Approver cannot approve their own record.
- **Employee hours visibility (per hotel, set by admin/super admin):**
  - `immediately`: the employee sees clock times, paid hours and totals as soon as the punch is complete; pending records are labelled "preliminary".
  - `after_approval`: the employee sees the date and a "waiting for approval" label for pending records, but no paid hours and no contribution to weekly/monthly totals; hours appear once approved. Rejected records show the reason given by the approver.
  - The kiosk is unaffected: the punch confirmation at the tablet always shows the timestamp. Hours totals, arbeitszeitkonto and target warnings are calculated from APPROVED records only, regardless of the visibility setting.
- **Shift planning authority:** super admin, admin and manager can plan shifts within their scope; hard blocks (double-booking across all hotels, time-off conflict, wrong department, past dates) and the compliance rules in the Legal Compliance Baseline apply identically to all three. Every change is audit-logged with actor and role.
- **Sickness is recorded on the plan:** employees report sickness to their manager by phone or in person; there is no sick request in the app. Planners mark the days as sick on the plan (`POST /manager/schedule/absence` with `type: sick_leave`), including past days: managers up to `sick_backdate_days` (default 7), admins/super admins any date with a reason; closed payroll periods need a logged correction. The edit cancels planned shifts (`cancel_reason = 'sick'`), creates the `sick_leave` entry, credits hours and refunds overlapping vacation days when a certificate exists. If a punch exists on that day it must be corrected or rejected first.
- **Overnight shifts and daylight saving:** `schedule.shift_date` is the local START date. All durations, rest periods and hour totals are computed from timestamps (a 22:00-06:00 shift starting 24 Oct 2026 is 9 h, one starting 27 Mar 2027 is 7 h). Night, Sunday and holiday minutes are split at local midnight.
- **Vacation:** BUrlG-based proration, statutory vs contractual days, notice duty before expiry, half days and holiday-aware counting - see Legal Compliance Baseline B.
- **Public holidays:** resolution order hotel > company > state > national (a lower scope may cancel an inherited holiday with `is_holiday = FALSE`). `gets_public_holiday` + salary + worked on a resolved holiday -> hours added to arbeitszeitkonto.
- **Dual role:** manager and employee records share one `user_account`; active role chosen at login; manager views never expose the person's own employee data beyond what the employee role allows, and a manager cannot approve their own requests (approval routed to another manager or admin).
- **Shift wish vs. time-off conflict (proposed default, not yet confirmed):** an approved time-off always wins over a shift wish; a pending leave wish does not block a shift wish; manager sees both flagged.

---

## Shift Planning Calendar

**Who:** super admin, admin and manager within their scope. Managers see display names (first name + last initial); admins and super admins see full names. Planning is done week by week; the month range is an overview.

### Layout

```
Hotel ▾  Dept ▾  [Employee view | Shift view]  [Week | Month]  ◀ 12-18 Oct ▶   [Draft ▾] [Publish]   ↶ ↷

EMPLOYEE VIEW   Mon 12        Tue 13       Wed 14   ...  Sun 18  | Week total
Maria S.        [Early ✂]     [Early]      [ + ]              | 32.0 / 40 h
Jan K.          [Late]        [Sick]       [ + ]              | 24.0 / 40 h  (+8.0 credit)

SHIFT VIEW      Mon 12        Tue 13       Wed 14   ...  Sun 18  | Week total
Early 06-14     Maria S.      Maria S.     Jan K.             | 64.0 h   1 open
  required      2/3 ┌open┐    3/3           2/3 ┌open┐
Late 14-22      Jan K.        Jan K.       Maria S.           | 72.0 h
Absent          Sam T. (vac)  Jan K. (sick)                   |
```

- **Header:** hotel and department filters, Employee view / Shift view, Week / Month, date navigator, Draft/Published status with a Publish button, undo/redo.
- **Employee view:** one row per employee, chips in the day cells (a split shift shows two chips).
- **Shift view:** one row per shift template, plus a "Custom" row for ad-hoc entries and a pinned "Absent" row. Each cell stacks the assigned employee chips and shows `assigned/required`; missing people appear as dashed "open" placeholders.
- **Total column on the right:** week total in week range, month total in month range. Employee view: per employee, compared to the contract target (`32.0 / 40 h`) with absence credits shown separately for salary workers. Shift view: per shift (total assigned hours plus open-slot count). A footer row shows per-day totals.
- **Markers:** unavailable windows shaded (availability), swap requests and published open shifts marked, public holidays in the column header, shift and leave wishes as small icons in the cell, pending time-off requests as hatched chips, warning triangle on chips that triggered a rule, dot on chips that are still draft.
- **Month range:** compact chips, same totals column per month. Editing happens in week range; clicking a week header opens it.
- **Phones:** below 768 px the grid becomes a day list per employee; tap-select, then tap the target instead of dragging.

### Interactions

- **Select a chip:** a small cut icon appears at its top right. It removes the entry from the cell. Removing a published shift notifies the employee; removing vacation or sick reverses allowance and credits.
- **Hover an empty cell:** a **+** appears. Clicking it opens a menu anchored to the button (no separate dropdown or dialog).
  - Employee view menu: shift templates (incl. split shifts), a divider, then Sick leave, Free day, Vacation, Unpaid day off and a **More** entry inside the same menu (comp time, special leave, child sick, training, parental and maternity leave, rest day).
  - Shift view menu: searchable list of employees. Those with time-off or an overlapping shift that day are greyed out with the reason. In the "Absent" row, pick the employee, then the absence type in a flyout of the same menu.
  - Clicking an open placeholder opens the same menu for that shift and day.
- **Ranges:** drag across empty cells or shift-click to select several days; one + menu applies the choice to the whole range (vacation over two weeks is one action).
- **Drag and drop (both views):** drag any chip to another cell; Alt-drop copies; dropping on another chip swaps; dragging a template from the palette creates an entry. While dragging, the target turns green (ok), amber (needs a reason, asked in an inline prompt) or red (blocked, with the reason in a tooltip).
- **Keyboard and touch:** tap/Enter selects, arrow keys move, Enter drops, Esc cancels.
- **Locked cells:** past days (except Sick leave), closed payroll periods, and days that already have a punch (a punch must be corrected first).
- **Undo/redo:** performs the inverse server call and is audit-logged.

### Absence menu

| Menu item | Stored as | Effect |
|---|---|---|
| Sick leave | `sick_leave` | cancels planned shifts, credits hours, past days allowed within limits |
| Free day | `off_day` | planned day off, no credit |
| Vacation | `annual_leave` | counts against allowance, credits hours; exceeding the remaining days needs a reason |
| Unpaid day off | `unpaid_leave` | no credit and lowers the monthly target (Legal Compliance C) |

### Required headcount

- Per shift: a weekday default plus optional date overrides (`shift_staffing_requirement`). Date override beats weekday default; no entry means no requirement.
- Shown as `assigned/required` in shift view. Shortage never blocks saving; publishing shows "N open slots" as a warning.
- Totals and open-slot counts are computed by the server, not the browser.

### API

All endpoints are served to manager, admin and super admin within scope (also under `/admin/...`).

- `GET /manager/schedule/grid?hotelId=:id&departmentId=:id&view=employee|shift&range=week|month&from=:date` -> rows, cells, absences, holiday and wish markers, warnings, totals, headcount, status
- `POST /manager/schedule/validate` `{ operation, ... }` -> dry run for drag feedback: `ok|needs_reason|blocked`, reasons, new totals; nothing is saved
- `POST /manager/schedule/entries`, `PUT /manager/schedule/entries/:id`, `DELETE /manager/schedule/entries/:id`
- `POST /manager/schedule/move`, `/copy`, `/swap`, `/bulk` (atomic; "copy last week" uses bulk)
- `POST /manager/schedule/absence` `{ employeeId, from, to, type, reason?, certificateStatus? }`, `DELETE /manager/schedule/absence/:id`
- `GET|PUT /manager/staffing-requirements`
- Every write carries the row `version`; a stale version returns 409 and the grid refreshes. Every write runs the full rule check from Legal Compliance A; the browser is never trusted.

Response sketch:
```json
{
  "view": "shift", "range": "week", "status": "draft",
  "rows": [{
    "shiftId": 7, "name": "Early", "weekTotalHours": 64.0, "openSlots": 1,
    "cells": [{ "date": "2026-10-12", "required": 3, "assigned": [
      { "scheduleId": 101, "employeeId": 12, "displayName": "Maria S.", "hours": 7.5, "warnings": [] }
    ]}]
  }],
  "absences": [{ "employeeId": 15, "type": "annual_leave", "from": "2026-10-12", "to": "2026-10-16" }]
}
```

### Build phase
Phase 1: week grid in both views, + menu, drag and drop, validation, publish, headcount. Phase 2: month overview totals. Phase 4: vacation allowance checks and hour credits for absences.

---

## Data Import & Export

### Catalogue

| # | Name | Dir. | Who | Formats | Notes | Phase |
|---|---|---|---|---|---|---|
| 1 | Employees | import | admin | xlsx | existing guide, dry run, duplicate handling | 1 |
| 2 | Shift templates + required headcount | import | admin | xlsx, csv | creates `shift` and `shift_staffing_requirement` | 1 |
| 3 | Public holidays (company/hotel) | import | admin | csv, ics | scope column decides company or hotel | 2 |
| 4 | Opening balances (vacation used, carryover, time account) | import | admin | xlsx | retroactive onboarding; writes `opening_balance` ledger entries | 2 |
| 5 | Schedule (initial or historic plan) | import | manager, admin | xlsx | same rule checks as the grid; past rows only as history, never re-notified | 2 |
| 6 | Absence history (vacation, sick, unpaid) | import | admin | xlsx | respects allowance and credits; audit-logged | 4 |
| 7 | Historic time records | import | admin | csv | `source = 'manual'`, only into open periods, reason required | 4 |
| 8 | Schedule | export | manager, admin, employee (own) | pdf (A3 landscape print), xlsx | filters: hotel, department, week/month, view | 1 |
| 9 | Personal calendar feed | export | employee | ics (secret URL, revocable) | published shifts and absences only | 6 |
| 10 | Timesheet (Stundenzettel) | export | manager, admin, employee (own, after approval per visibility setting) | pdf, xlsx | per employee and month: planned vs actual, breaks, approved hours, night/Sunday/holiday minutes, absences, signature lines | 2 |
| 11 | Attendance, late/early, under-break, auto-checkout reports | export | manager, admin | csv, xlsx | the report screens, same filters | 2 |
| 12 | Compliance report | export | manager, admin | csv, pdf | overrides, rest compensation, Sundays, night workers | 3 |
| 13 | Vacation overview and notices log | export | admin | xlsx, pdf | allowance, used, carryover, notice dates | 4 |
| 14 | Time account statement | export | admin, employee (own) | pdf, xlsx | ledger with opening balance | 4 |
| 15 | Payroll export | export | admin | csv, datev | closed periods only; layout agreed with the tax adviser | 7 |
| 16 | Employee list | export | admin | xlsx | never includes PINs | 2 |
| 17 | Audit log | export | admin, super admin | csv | filters; includes hash-chain verification result | 3 |
| 18 | Own data (GDPR Art. 15) | export | employee | json + pdf | all personal data and change history | 6 |
| 19 | Company data package (portability / offboarding) | export | super admin | zip of csv | on request, logged | 7 |
| 20 | Exit statement | export | admin | pdf | remaining vacation (incl. payout days), time account, open items | 4 |
| 21 | Plan vs actual and analytics | export | manager, admin | xlsx, csv | aggregated KPIs | 7 |
| 22 | Qualification and document expiry list | export | admin | xlsx | expiring in the next 90 days | 5 |
| 23 | Occupancy forecast | import | admin, manager | csv | from the PMS; feeds staffing suggestions | 9 |
| 24 | Qualifications per employee | import | admin | xlsx | with expiry dates | 5 |

### Common rules

**Imports** (one pipeline for all types): download template -> upload (xlsx or csv, max 10 MB, max 5,000 rows, .xlsm rejected, malware scan) -> dry run with row-level errors and preview -> confirm -> atomic commit per job -> result and `errors.csv`. Same validations as the screens, same audit trail, formula injection neutralised, idempotent by job id. Large jobs run asynchronously.

**Exports**
- Role scope applies: managers get display names and no email, date of birth or PIN; admins within their companies; super admin everywhere.
- Every export is logged in `audit_log` (who, type, filters, row count).
- Files are generated asynchronously when large, stored encrypted, downloadable for 24 h and deleted after 7 days.
- CSV: UTF-8 with BOM, semicolon separator and decimal comma option for German Excel, formula injection neutralised. PDFs are A4/A3, German by default with English option.
- Calendar feed tokens are random, revocable, and rotate on request.

### API

- `GET /admin/import-templates/:type`
- `POST /admin/imports/:type` `{ file, dryRun, options }` (`/admin/employees/import` stays as an alias for `employees`); `GET /admin/imports/:jobId`; `GET /admin/imports/:jobId/errors.csv`
- `POST /exports` `{ type, format, filters }` -> `202 { jobId }`; `GET /exports/:jobId` -> status and download link (role-scoped; also under `/manager/...` and `/employee/...` for own data)
- `POST /employee/me/calendar-feed` (create or rotate), `DELETE /employee/me/calendar-feed`, `GET /feeds/:token.ics`

---

## Additional Features (v3.3)

Added after benchmarking against German hospitality tools (see Feature Coverage Review in Product Concept). Each item lists its rules, API and phase.

### 1. Shift swaps and open shifts (Phase 5)

- **Swap / giveaway:** an employee offers one of their published future shifts (`shift_swap_request`) to a named colleague (1:1 swap with `counterpart_schedule_id`) or to anyone eligible (giveaway). The counterpart accepts in the app, then the request goes to a manager/admin (company setting `swap_approval`: `manual` default, or `auto_if_valid`).
- **Eligibility is checked by the server** for both people with the full rule check (rest periods, daily/weekly limits, minors, overlaps, department, required qualification, availability, time-off). If a check fails the swap is blocked with the reason.
- **Open shifts:** a planner turns an open slot into an `open_shift` visible to eligible employees; employees apply (`open_shift_claim`), the planner picks one, and the schedule row is created. Only one claim can be approved.
- Requests expire (default 48 h or when the shift is within 12 h) and every step notifies the people involved.
- API: `POST /employee/swap-requests`, `PUT /employee/swap-requests/:id/accept`, `GET /employee/open-shifts`, `POST /employee/open-shifts/:id/claim`; `GET /approvals/swaps`, `PUT /approvals/swaps/:id`; `POST /manager/open-shifts`, `PUT /manager/open-shifts/claims/:id`.
- UI: a swap icon on own chips in the employee schedule; planners see swap requests in the approvals inbox and open shifts as dashed chips with a "published to staff" marker.

### 2. Availability and qualifications (Phase 5)

- **Availability:** employees maintain recurring "cannot work" and "prefer to work" windows (`employee_availability`). The grid shades unavailable windows; planning into them needs a reason (`warn_reason`), planning into preferred windows is highlighted.
- **Qualifications:** admin defines qualifications (first aider, night porter, hygiene instruction, ...) with optional expiry (`employee_qualification`). A shift may require one (`shift.required_qualification_id`); assigning an unqualified or expired person warns the planner. Expiry reminders go to admin 30 and 7 days before.
- **Floaters:** `employee.is_floater` marks staff who may cover other hotels; in the shift view + menu a section "Floaters from other hotels" lists them (subject to all rule checks across hotels).

### 3. Absence types, comp time and absence planning (Phase 4)

- Absence types come from the `absence_type` table. The calendar + menu shows the four primary types and a "More" entry in the same anchored menu for the rest.

| Type | Allowance | Credits hours | Lowers target | Certificate | Notes |
|---|---|---|---|---|---|
| annual_leave (Vacation) | yes | yes | no | no | |
| sick_leave | no | yes | no | yes (from day 4) | marked on the plan by planners |
| off_day (Free day) | no | no | no | no | planned day off |
| unpaid_leave | no | no | yes | no | |
| comp_time (Zeitausgleich) | no | no | no | no | salary workers only; the account falls by the daily target because the day is neither worked nor credited |
| special_leave | no | yes | no | no | paid special leave |
| child_sick | no | no | yes | no | confirm payroll treatment |
| training | no | yes | no | no | |
| parental_leave | no | no | yes | no | vacation accrual may be reduced (see Legal B) |
| maternity_leave | no | no | yes | no | confirm payroll treatment |
| rest_day | no | no | no | no | replacement rest day for Sunday/holiday work |
| public_holiday | no | yes | no | no | system-generated |

- **Comp time** requires a sufficient account balance (or `account_min_hours` not breached); otherwise `warn_reason`.
- **Blackouts and minimum staffing:** `absence_blackout` blocks or limits vacation in a period (`max_concurrent_absent`, NULL = no vacation); `department.max_concurrent_absent` is the default cap. When approving or planning vacation the server shows who else is absent and warns or blocks per setting.
- **Team calendar:** `company.team_absence_visibility` (`none` default, or `names_only`): employees see colleagues as "away" without the reason; sickness is never shown to colleagues.

### 4. Documents and offboarding (Phases 4 and 6)

- **Documents:** admins upload personnel documents per employee (contract, hygiene instruction under the Infection Protection Act, work permit, training certificates, payslips as PDFs) with optional expiry and a flag whether the employee sees them. No health data. Stored encrypted; downloads are logged. Expiry list for admin; reminders 30 and 7 days before.
- **Offboarding:** `POST /admin/employees/:id/terminate` `{ lastDay, reason? }` sets `contract_end_date`, blocks planning after the last day, produces an exit statement (remaining vacation incl. days to be paid out under BUrlG § 7 Abs. 4, time account balance, open approvals, open requests), disables kiosk PIN and login after the last day and schedules anonymisation per retention. Fixed-term contract end and probation end alerts go to the admin 30 and 14 days before.

### 5. Announcements (Phase 6)

Read-only company or hotel announcements with pinning and optional read confirmation (`requires_ack`); admin sees who has not confirmed. API: `POST /admin/announcements`, `GET /employee/announcements`, `PUT /employee/announcements/:id/ack`.

### 6. Time recording options (Phase 2)

- **Badge identification (optional):** `hotel.kiosk_identification = 'badge_pin'`: NFC badge or QR on the phone identifies the employee, the PIN still confirms. Only a hash of the badge id is stored (`employee.badge_hash`). Name + PIN remains the default and the fallback.
- **Break start/stop (optional):** `hotel.break_mode = 'start_stop'`: the kiosk offers Start break / End break and fills `break_segments`; at clock-out the total is confirmed. Default `confirm_at_clock_out`. API: `POST /tablet/break-start`, `POST /tablet/break-end`.
- **Web punch control:** `hotel.web_punch_allowed_cidrs` limits web punches to the hotel network; no GPS tracking.
- **No-show alert:** if no punch exists 15 minutes after a planned start, the manager gets an alert (and the employee a reminder if they have an account).
- **Explicitly excluded:** biometric identification (GDPR Art. 9, works council) and continuous location tracking.

### 7. Hour categories (Phase 7)

`hour_category` defines windows that produce payroll-ready minutes per punch (`punch_record_category_minutes`): defaults night (23:00-06:00), Sunday, public holiday, plus custom ones such as 24 and 31 December from 14:00. Minutes are computed at period close from timestamps and the holiday calendar and flow into timesheets and the payroll export. The system never calculates wages.

### 8. Analytics (Phase 7)

Dashboards for admin and manager: planned vs actual hours, overtime and time-account totals per department, open slots, approvals aging, rule overrides, punch correction rate, absence rate. Privacy rules: absence figures only aggregated per hotel/department with at least 5 employees; no per-employee absence ranking or scoring; no sick-leave details for managers beyond the plan.

### 9. Occupancy-based staffing suggestions (Phase 9, optional)

Import an occupancy forecast (CSV from the PMS, `occupancy_forecast`: occupied rooms, arrivals, departures per date). `staffing_rule` converts it into a suggested headcount per shift (e.g. one room attendant per 14 departures plus stayovers). The shift view shows the suggestion next to the required headcount; the planner can adopt it with one click. Suggestions only; nothing is planned automatically.

### 10. Setup wizard and small items (Phase 1)

- **Setup wizard** for a new hotel: company/hotel -> departments -> shift templates and headcount -> public holidays -> kiosk device -> employee import -> first plan.
- **Manager scope by department:** `manager_department` limits a manager to departments (no rows = all departments of the assigned hotels).
- **Contact data:** optional `employee.phone`; managers see it only if `company.managers_can_see_phone` is on.

### 11. Deferred or excluded

| Item | Decision |
|---|---|
| Auto-generated plans | Deferred (Phase 9+, suggestion-only "fill open slots") |
| Public API / webhooks, SSO (Entra, Google) | Deferred (Phase 9) |
| Social network and chat | Deferred (Phase 8) |
| Electronic sick notes (eAU) retrieval | Out of scope: payroll or health-insurer channel; certificates are tracked manually |
| Native mobile apps | Out of scope: installable PWA with web push |
| Biometrics, GPS tracking | Excluded |
| Wage and payroll calculation | Out of scope |

---

## Legal Compliance Baseline (Germany)

> Working basis, not legal advice. Have an Arbeitsrechtler, your Datenschutzbeauftragter and (if you have one) the Betriebsrat confirm these rules before go-live. If a collective agreement (e.g. DEHOGA) applies, create a `collective_agreement` rule profile that overrides the defaults.

### A. Working-time rules (enforced by the planning and punch engine)

Rules live in `rule_profile.rules` (company default, optional hotel override; employee overlays for minors and maternity protection are applied automatically). Enforcement levels: `block` (cannot be saved), `block_unless_emergency` (admin/super admin with reason), `warn_reason` (saved only with a reason, shown on the compliance report), `warn`.

| Topic | Source | Rule | Default enforcement |
|---|---|---|---|
| Daily maximum | ArbZG § 3, § 14 | 8 h; up to 10 h if the 24-week (6-month) average stays at 8 h | > 10 h `block_unless_emergency`; > 8 h `warn` with running average |
| Weekly average | ArbZG § 3 / EU directive | average 48 h over 24 weeks | `warn` on forecast |
| Breaks | ArbZG § 4 | more than 6 h net: 30 min; more than 9 h net: 45 min; blocks of at least 15 min; no more than 6 h in a row without a break | `warn_reason` if actual < required |
| Rest period | ArbZG § 5 | 11 h. Hospitality (§ 5 Abs. 2): may be cut by up to 1 h (to 10 h) if another rest of at least 12 h follows within the calendar month or 4 weeks | < 11 h `warn_reason` and compensation tracking; < 10 h `block_unless_emergency` |
| Sundays and holidays | ArbZG §§ 9-11 | work allowed in hospitality; at least 15 Sundays off per year; replacement rest day within 2 weeks (Sunday) / 8 weeks (holiday) | `warn` when planning would breach |
| Night work | ArbZG § 6 | night = 23:00-06:00; night worker (about 48 nights/year): average 8 h per month/4 weeks, health check right | `warn`; flag employee and notify admin |
| Minors (under 18) | JArbSchG | 8 h/day, 40 h/week, 5-day week, 12 h rest, breaks 30 min (> 4.5 h) / 60 min (> 6 h), night ban 20:00-06:00 with hospitality exceptions | `block` (profile `minor`, from `date_of_birth`) |
| Maternity | MuSchG § 5 | no work 20:00-06:00; Sunday/holiday only with documented consent | `block` / `warn` (profile `maternity`) |
| Minijob hours | admin-defined | `monthly_hours_cap` per contract (2026: limit 603 EUR, minimum wage 13.90 EUR -> about 43 h; 2027: 633 EUR / 14.60 EUR) | `warn` at 90% and 100% of planned + approved hours |

Every override stores actor, role, reason and rule key in `audit_log` and appears in `GET /manager/compliance-report`. The checks run across ALL hotels of the employee (the employee row is the employment), not per hotel.

Sample `rules` JSON:
```json
{
  "maxDailyHours": {"value": 10, "enforcement": "block_unless_emergency"},
  "dailyAverageWeeks": 24,
  "minRestHours": {"value": 11, "hospitalityFloor": 10, "compensationRestHours": 12, "compensationWindow": "month_or_4_weeks", "enforcement": "warn_reason"},
  "breaks": {"over6hMinutes": 30, "over9hMinutes": 45, "minSegmentMinutes": 15, "maxStretchHours": 6},
  "sundaysOffPerYear": 15,
  "nightWindow": {"from": "23:00", "to": "06:00"},
  "recordingDeadlineDays": 7
}
```

**Break calculation (net working time, not shift length).** For gross presence time G:
- G <= 6 h: required 0
- 6 h < G <= 6 h 30: required = G - 6 h (the break that brings net time back to 6 h)
- 6 h 30 < G <= 9 h 30: required 30 min
- G > 9 h 30: required 45 min

**Daylight saving.** All durations come from timestamps. A 22:00-06:00 shift starting on 24 Oct 2026 (clocks go back at 03:00 on 25 Oct) is 9 h; one starting on 27 Mar 2027 (clocks go forward on 28 Mar) is 7 h. Add these two shifts to the test suite.

**Night, Sunday and holiday minutes** are computed by splitting each punch at local midnight and applying the resolved holiday calendar, so hours after midnight on a holiday are credited correctly even though `shift_date` is the start date.

### B. Vacation and absence rules (BUrlG, EFZG)

- **Entitlement belongs to the employment** (employee row), keyed by year, never by hotel.
- **Statutory minimum:** 4 weeks = 4 x `work_days_per_week` days (20 days for a 5-day week). `statutory_days = MIN(total, 4 x work_days_per_week)`; the rest is contractual. Statutory extras (e.g. for severe disability) are simply part of the admin-entered total; the reason is not stored.
- **Proration (BUrlG § 5):** if the waiting period (6 months, § 4) is completed within the calendar year, the employee gets the full annual entitlement; otherwise 1/12 per full month employed in that year. Fractions of at least 0.5 round up to a full day. Leaving mid-year follows the same logic (leaving in the second half-year: full entitlement). Admin override remains possible.
  - Examples (30 days): start 15 Jan -> 30 days (waiting period ends 15 Jul); start 1 Nov -> 2/12 x 30 = 5 days; start 31 Dec -> 0 days.
- **Counting:** only the employee's working days count, public holidays inside a leave period are excluded, half days (0.5) are supported (`time_off_days` is DECIMAL).
- **Carryover and expiry:**
  - Employer duty to inform: the system sends and logs `vacation_notice` rows (initial notice by 1 Oct, reminder by 15 Nov, final reminder by 15 Feb; dates configurable).
  - Statutory days carried over expire on 31 Mar ONLY if the notices were sent. If not, the days stay valid and the admin sees an alert.
  - `carryover_limit_days` caps only the contractual days.
  - Long-term illness: statutory days expire 15 months after year-end (confirm with counsel).
- **Parental leave (BEEG § 17):** the employer may reduce vacation by 1/12 per full month of parental leave; the system only does this after an explicit admin action (`reduces_vacation_accrual` declaration) and logs it.
- **Absence types:** credits, targets and allowance per type come from `absence_type` (see Additional Features 3).
- **Sick during vacation (§ 9 BUrlG):** when a sick leave with certificate overlaps approved vacation, the overlapping days are refunded to the allowance automatically.
- **Sick leave (EFZG):** employees report sickness to their manager directly (phone, message, in person); there is no sick request in the app. The manager, admin or super admin marks the days as sick ON THE PLAN, also for past days. The plan edit creates the `sick_leave` entry, cancels any planned shift on those days (`cancel_reason = 'sick'`) and credits hours. Managers may go back `sick_backdate_days` (default 7, company setting); admins and super admins any date with a reason; a closed payroll period needs a logged correction. Certificate: tracked manually in `certificate_status` (required from the 4th calendar day unless company policy says earlier). If a punch exists on a day being marked sick, the planner must first correct or reject that punch.

### C. Time account (Arbeitszeitkonto) rules

- Salary workers with targets only; hourly workers have no account.
- **Ledger:** every change is a row in `arbeitszeitkonto_entry`; `arbeitszeitkonto.balance_hours` is the cached sum.
- **Target (Soll):** monthly target = `target_hours_per_month`, or weekly target x 52/12 (4.3333) if only weekly is given; prorated by calendar days when a contract starts, ends or changes mid-month. Booked as a negative `target` entry at month close.
- **Credits:** approved worked hours -> `worked`; vacation, sick and holiday days (`credits_hours = TRUE`) -> `absence_credit` of `daily_target_hours` per working day. This prevents a vacation week from showing -40 h.
- **Unpaid leave:** each `unpaid_leave` day lowers the monthly target by the daily target (a positive `target` correction entry), so an unpaid day never creates an hours debt.
- Optional `account_min_hours` / `account_max_hours` raise alerts; payouts are `payout` entries.
- Only APPROVED records count (see Worked-time approval).

### D. Recording, approval and retention

- **Actual times are the legal record.** `actual_punch_in/out` are never overwritten; grace-period rounding only affects `paid_start/paid_end`. Every change is written to `punch_record_history` and visible to the employee.
- **Deadlines:** records are created at the punch (same day) and must be reviewed within 7 days (reminder on day 5, escalation to admin on day 7). The reform draft of June 2026 aims at same-day electronic recording; the design already satisfies it.
- **Period close:** `payroll_period` locks a month. After closing, edits are only possible as logged corrections by admin/super admin.
- **Retention:** default `retention_months = 36` (legal minimum for time records is 24 months). If the records serve as payroll basis your tax adviser may require 6-10 years - confirm, then set the value per company. A nightly job anonymises or deletes expired data and logs the run.
- **Employee corrections:** employees can request a missing or wrong punch (`time_correction_request`); managers, admins or super admins decide.

### E. Data protection and co-determination

- Works council (§ 87 Abs. 1 Nr. 2, 3, 6 BetrVG): kiosk, time recording, schedule publication and any social features need a works agreement if a Betriebsrat exists. Prepare a checklist and the agreement annex from this spec.
- GDPR/BDSG: processing basis is the employment contract and legal duties (not consent). Prepare the record of processing activities (Art. 30), run a DPIA screening (Art. 35), sign processor agreements (Art. 28) with hosting and email providers, host in the EU, encrypt at rest and in transit.
- Data minimisation: managers see a display name (first name + last initial), not email, contact data, date of birth or PIN. The kiosk roster shows display names only.
- Employee rights: `GET /employee/me/data-export` (Art. 15), change history per punch record, no behavioural scoring.
- Audit log is append-only with hash chaining; the application database role cannot update or delete it.

### F. Items to confirm with counsel

1. Whether a collective agreement applies (rule profile overrides).
2. Final retention periods per record type.
3. Wording of the vacation notices and the escalation steps.
4. Rounding of paid times inside the grace period (no systematic disadvantage for employees).
5. Works council agreement and DPIA outcome before the kiosk goes live.
6. Payroll treatment of child-sick, maternity-protection and parental-leave days (credits and targets).
7. Parental-leave vacation reduction wording and the hygiene-instruction (IfSG) document handling.
8. Whether shift swaps between employees need any contractual basis in your employment contracts.

---

## Security

### Authentication & Authorization

**Password Security:**
- Minimum 12 characters
- Must include: uppercase, lowercase, number, symbol
- Bcrypt hashing (rounds: 12)

**PIN Security (Employee):**
- 4 to 8 digits (company setting, default 4), one PIN per employee, no forced rotation
- Hashed with argon2id/bcrypt and verified only AFTER the employee has been selected on the kiosk (name first, then PIN)
- 5 wrong attempts lock the employee for 15 minutes (escalating); admin is notified after 3 locks in 24 h and can unlock
- Shown once to the admin at creation/reset, never emailed, never retrievable

**Additional controls (v3.0):**
- TOTP two-factor authentication mandatory for admin and super admin
- Invitation tokens stored hashed; kiosk devices registered with revocable tokens
- PostgreSQL row-level security per company (defence against missing WHERE clauses)
- Append-only audit log with hash chain (application role cannot UPDATE/DELETE)
- Excel/CSV: neutralise formula injection (prefix cells starting with = + - @), reject .xlsm, size and row limits, malware scan on upload
- Secrets in a secret manager, encrypted backups with a restore test every quarter, EU-region hosting, dependency scanning in CI

**JWT Tokens:**
- Access token: 15 minutes
- Refresh token: 7 days (httpOnly cookie)
- No token reuse

**Account Lockout:**
- 5 failed login attempts → 15 min lockout
- Attempted logins logged to audit_log

**Rate Limiting:**
- Login: 5 attempts per 15 minutes per IP
- Punch (clock in/out): 10 per minute per employee
- API endpoints: Standard rate limiting

### Data Protection

**SQL Injection Prevention:**
- Parameterized queries only
- No string concatenation

**CSRF Protection:**
- CSRF tokens on all state-changing endpoints

**Authorization Middleware:**
- All endpoints check user role + data ownership
- Company/hotel filtering applied
- Personal data only visible to: user, admin, super-admin

**Audit Logging:**
- All state changes logged: action, actor, timestamp, IP, user agent
- Immutable logs (append-only)
- Retention: 6 years (German labor law)

**HTTPS & Transport Security:**
- TLS 1.3 only
- HSTS headers

**Security Headers:**
- Helmet.js (X-Frame-Options, X-Content-Type-Options, etc.)
- CORS policy: specific origins only

### Data Privacy

**GDPR Compliance:**
- Data export endpoint (employee can export their data)
- Retention policy: 6 years (employment records)
- Personal data deleted on employee deactivation (if no legal hold)

---

## Tablet/Kiosk Punch System

**Purpose:** Fast clock-in/clock-out on a shared tablet at the staff entrance (separate from the employee web dashboard).

**Device registration**
- Every tablet is registered by an admin (`POST /admin/kiosk-devices`); the device token is shown once and stored in secure device storage.
- All kiosk requests carry `X-Kiosk-Token`. Unknown or revoked devices are rejected.
- Server time is the only time source. A device clock drifting more than 60 s raises an admin alert.

**Roster (privacy-minimised)**
- Shows only `display_name` (first name + last initial), department and planned times.
- Only shifts starting within the next 2 h or ended less than 2 h ago are listed (configurable). No photos, no contact data.
- Screen dims after 30 s without interaction. Employees not on the roster use "Search name" (min. 2 characters, max. 5 results).

**Punch flow (name first, then PIN)**
1. Employee taps their name. The roster entry carries an opaque, signed `employeeRef` (valid 5 min, bound to the device).
2. Employee enters the PIN. The server verifies it against THAT employee only (argon2id/bcrypt). Guessing a valid PIN for "somebody" is no longer possible.
3. Clock-in: server timestamp is stored, confirmation shows the time, screen returns to the roster after 10 s.
4. Clock-out: step 1 returns the break proposal and a short-lived `confirmToken`; step 2 confirms the actual break (no second PIN entry). See Break Tracking.
5. Employee not on the roster or no planned shift: punch is stored as `is_unplanned = true` and a `time_variation` of type `unplanned` is created for review.
6. A second clock-in within 60 s is ignored; a clock-in while a record is open becomes a clock-out prompt.

**PIN protection**
- 5 wrong PINs lock that employee on all kiosks for 15 minutes (escalating); the admin is notified after 3 locks in 24 h and can unlock (`POST /admin/employees/:id/unlock-pin`).
- Every failure is audit-logged with device and time.
- No remote clock-in unless the hotel enables `allow_web_punch`; web punches are stored with `source = 'web'` and flagged.
- Optional photo capture at the kiosk is NOT part of the spec; it would need a works council agreement and a data protection impact assessment first.

**Offline behaviour**
- If the network is down the kiosk queues punches locally (encrypted) with a monotonic offset. PIN verifiers are cached only for today's roster, encrypted at rest, and offline mode is limited to 24 h.
- On sync the server stores `source = 'kiosk_offline'`, sets `offline_punch = true` and forces manual review.

**Kiosk API**
- `GET /tablet/roster?hotelId=:id` -> `[{ employeeRef, displayName, department, plannedStart, plannedEnd, state }]`
- `GET /tablet/search?q=:text`
- `POST /tablet/punch-in` `{ employeeRef, pin }`
- `POST /tablet/punch-out` `{ employeeRef, pin }` -> break proposal + `confirmToken`
- `POST /tablet/punch-out/confirm-break` `{ confirmToken, actualBreakMinutes, breakSource }`
- `GET /tablet/punch-status?employeeRef=:ref` (no PIN in the URL)

**Kiosk mode:** auto-logout, no navigation, stateless, no personal data beyond the display name.

---

## Tech Stack

**Backend:**
- Node.js + Express (or NestJS)
- PostgreSQL (relational, transaction support)
- JWT authentication (employee/manager/admin dashboards)
- Bcrypt/argon2id for passwords and PINs (PIN verified only after the employee is selected)

**Frontend — Two Separate Interfaces:**

**1. Employee/Manager Web Dashboard:**
- React + Zustand (state management)
- JWT-based login (email + password)
- Features: Schedule view, hours summary, shift wishes, time-off requests, approval workflows
- Browsers: Desktop/tablet browsers (responsive design)

**2. Tablet Kiosk (Punch-Only):**
- React Native or Flutter (simplified app for tablet/iPad)
- OR: Web-based (HTML5, works on any tablet browser in kiosk mode)
- Device-registered kiosk: name selection + PIN (no password)
- Features: Daily roster, clock in/out, break confirmation
- Auto-logout, stateless, high-throughput punch design

**Notifications:**
- Installable PWA with web push for employees and managers (no native apps); email as fallback

**Email:**
- EU-region transactional email provider with a signed data processing agreement (e.g. EU region of Mailgun); emails per employee language

**DevOps:**
- Docker (containerization)
- GitHub Actions (CI/CD)
- PostgreSQL backups (daily)

---

## Phase Plan

> **Phase 1 risk note:** Phase 1 keeps everything you decided to keep, so plan 6-8 weeks for one developer. Build in this order and demo after each step: auth and onboarding -> shifts and planning calendar -> kiosk punch + breaks -> corrections and auto-checkout -> Excel import -> schedule export. The first usable pilot (M1) is reached at the end of Phase 2.

| Phase | Duration | Focus |
|---|---|---|
| **0** (parallel) | 1-2 weeks | Legal and works council confirmation, DPIA screening, EU hosting and processor agreements, rule profile sign-off |
| **1** | 6-8 weeks solo (about 4 with two developers) | Accounts + role selector, setup wizard, onboarding (employee + contract), Excel import, planning calendar (both views, drag and drop, headcount, schedule PDF/Excel), kiosk punch, breaks, grace period, auto-checkout, corrections |
| **2** | 3 weeks | Hours tracking, worked-time approval, visibility setting, no-show alerts, month close, timesheet PDF, attendance reports, optional badge and break start/stop |
| **3** | 2 weeks | Compliance engine (limits, rest compensation, Sundays, night, minors, maternity), override audit, hash-chained audit log |
| **4** | 4 weeks | Vacation (BUrlG), sickness on the plan, absence types and comp time, blackouts and minimum staffing, time-account ledger, offboarding, documents (admin) |
| **5** | 3 weeks | Shift and leave wishes, availability, shift swaps, open shifts, qualifications |
| **6** | 2-3 weeks | Employee dashboard (PWA, web push), announcements, documents for employees, calendar feed, data export |
| **7** | 2 weeks | Payroll export (CSV, DATEV), hour categories, analytics, remaining exports |
| **8** | deferred | Social network after legal and works council sign-off |
| **9** | optional | Occupancy-based staffing suggestions, auto-fill suggestions, public API, SSO |

---

## Employee Personal Dashboard (Phase 6)

> Worked-hours widgets follow the hotel's hours-visibility setting (`immediately` or `after_approval`); see Business Rules.

**Purpose:** Employee self-service portal to view & manage their own data (web & mobile)

**Access:** Email + password login (separate from tablet kiosk PIN-only interface)

**Key Sections:**

**1. Profile**
- Name, email, contact info
- Primary hotel + department(s)
- Contract dates, working model (hourly/salary)
- Current work targets (hours/week, hours/month)
- View-only (admin manages employment terms)

**2. My Schedule**
- Calendar view: shifts assigned for next 30 days
- Week view: hours summary, targets comparison
- Shift details: start/end, department, paid hours, break requirements
- Status: confirmed, pending changes, conflicts

**3. Time & Attendance**
- Current punch status: clocked in/out, time
- Last 7 days punch records: times, paid hours, break taken
- Monthly hours summary: total paid hours vs. target
- Under-break violations flagged

**4. Vacation & Time-Off**
- Vacation days remaining this year
- Vacation days used (with dates)
- All approved time-off requests (dates, type)
- Option to request new time-off (annual_leave, unpaid_leave)

**5. Arbeitszeitkonto (Salary Workers Only)**
- Current overtime balance (positive = hours owed to employee)
- History: monthly overtime accumulation
- Overtime paid out (if any)
- Projected balance at year-end

**6. Requests & Approvals**
- Pending shift wishes (submitted, awaiting manager approval)
- Pending time-off requests (submitted, awaiting approval)
- Approved shift wishes (calendar marked)
- Rejected requests (reason shown)

**Technologies:**
- Web: React + responsive design (desktop/tablet browsers)
- Mobile: React Native or PWA (progressive web app)
- State: Zustand (same as manager dashboard)

---

**7. Shift swaps and open shifts** - offer a shift, accept a colleague's offer, apply for open shifts (Phase 5)

**8. Availability** - recurring "cannot work" and "prefer to work" windows (Phase 5)

**9. Documents** - own documents the admin made visible (contract, payslips, certificates) (Phase 6)

**10. Announcements and team calendar** - announcements with read confirmation; colleagues shown as "away" without reason if the company enables it (Phase 6)

**11. Installable web app with push notifications** - replaces native apps (Phase 6)

---

## Social Feed & Community (Phase 8 — Deferred, Opt-In)

> v3.0: DEFERRED. Employee consent is a weak legal basis in employment, a social network needs works council co-determination (§ 87 Abs. 1 Nr. 6 BetrVG) and creates moderation duties. Phase 6 ships read-only company announcements instead. Build the social network only after legal and works council sign-off.

**Purpose:** Internal social network for employee engagement, announcements, team updates (Facebook/Twitter-like features)

**Key Features:**

**1. Activity Feed**
- Posts from employees you follow
- Company announcements (admin-posted, auto-follow)
- Team updates from managers (optional)
- Like/comment on posts
- Real-time or daily digest (user preference)
- Threaded replies (nested comments)

**2. Posts & Sharing**
- Employees can post text updates
- Share photos (team events, celebrations, achievements)
- Tag colleagues (mention @username)
- Edit/delete own posts within 1 hour
- Emoji reactions (like, love, laugh, helpful, etc.)
- Link preview (OpenGraph metadata)

**3. Friends / Followers System**
- Send friend requests to colleagues
- Accept/decline friend requests
- Unfollow without notification
- See follower count on profile
- Block users (prevents interaction, hides their posts)
- Mutual friend connections

**4. User Profile (Social)**
- Profile photo (optional, uploaded)
- Bio / Department / Location
- Employment start date at company
- Friends/followers list
- Posts by this person (feed history)
- Privacy settings (public/friends-only/private)

**5. Privacy & Consent Controls**

**Opt-In/Out of Social Feed (Dynamic, Anytime):**
- Employees can join/leave the social feed at any time via settings
- NOT a one-time decision at onboarding
- Default: Social feed section visible, but employee must actively "Join Community" to participate
- Once joined: Can post, comment, follow, interact
- Can leave anytime: Posts archived, visible in history, but no longer creating new content
- Deactivated users: Profile hidden, posts removed from active feed

**Admin Announcements (Mandatory Visibility):**
- Company announcements posted by admin are visible to ALL employees
- Regardless of social feed opt-in status
- Pinned at top of feed for high visibility
- Cannot be opt-out of (company needs reach)
- Employees still cannot comment on announcements if they haven't joined social feed

**Post Visibility Settings (Per Post):**
- Public (all employees can see, even non-followers)
- Friends only (only accepted friends can see)
- Private (only visible to author, not in feed)

**Feed Customization (When Joined):**
- Follow/unfollow specific people
- Mute posts from certain departments or keywords
- Hide specific users without blocking
- Daily digest instead of real-time notifications
- Push notifications: on/off
- Email notifications: on/off

**6. Moderation & Safety**
- Report inappropriate posts (offensive, harassment, spam)
- Admin review reported content
- Suspend/remove posts that violate policy
- Suspend/block abusive users
- Profanity filter (optional)
- GDPR: Export personal data from feed
- GDPR: Delete all posts & comments when account deactivated

**7. Admin Controls (Social Feed)**
- Post company announcements (pinned, high visibility)
- See usage statistics (active users, daily posts, engagement rate)
- Moderation dashboard (pending reports, flagged content)
- Remove harmful content
- Suspend users for violations
- Auto-archive old posts (older than 1 year)
- Analytics: post frequency by department, engagement trends

**8. API Endpoints (Phase 8)**
- `POST /feed/posts` — Create post (text, photo)
- `GET /feed/posts?limit=20&offset=0` — Get feed (personalized, follows + public)
- `POST /feed/posts/:id/like` — Like a post
- `POST /feed/posts/:id/comment` — Add comment
- `POST /feed/posts/:id/delete` — Delete own post
- `POST /friends/request?toUserId=:id` — Send friend request
- `PUT /friends/request/:id` — Accept/decline request
- `DELETE /friends/:id` — Unfollow/remove friend
- `PUT /profile/privacy` — Update privacy settings
- `GET /profile/:userId` — View user profile (respects privacy)

**Database Tables (Phase 8):**
- USER_PROFILE (extends EMPLOYEE with social fields: bio, photo_url, privacy_settings)
- FEED_POSTS (id, author_id, content, photo_url, visibility, created_at, updated_at)
- FEED_COMMENTS (id, post_id, author_id, content, created_at)
- FEED_LIKES (id, post_id, author_id, reaction_type, created_at)
- FEED_MENTIONS (id, post_id, mentioned_user_id, created_at)
- FRIENDSHIPS (id, user_id, friend_id, status, created_at) — status: pending/accepted/blocked
- FEED_PREFERENCES (user_id, notifications_on, daily_digest, muted_users)
- REPORTED_POSTS (id, post_id, reporter_id, reason, status, created_at)

---

## Break Tracking — German Labor Law (ArbZG § 4)

### Automatic Break Rules (ArbZG § 4)

The required break is derived from net working time. With gross presence time G:

| Gross presence time G | Required break |
|---|---|
| up to 6 h | none (voluntary break may be recorded, not deducted) |
| more than 6 h up to 6 h 30 | G minus 6 h (e.g. 20 min for 6 h 20) |
| more than 6 h 30 up to 9 h 30 | 30 minutes |
| more than 9 h 30 | 45 minutes |

Breaks are taken in blocks of at least 15 minutes, with no more than 6 hours of work in a row. The employee confirms the actual break at clock-out; if it is shorter than required, `under_break_warning` is set and a reason is requested. Paid hours = G minus actual break.

**Examples**
```
06:00-14:30 (G 8 h 30)  -> required 30 min -> paid 8.0 h
07:00-17:00 (G 10 h)    -> required 45 min -> paid 9.25 h
14:00-18:30 (G 4 h 30)  -> required none   -> paid 4.5 h (ask if a break was taken)
06:00-12:20 (G 6 h 20)  -> required 20 min -> paid 6.0 h
```

### Grace Period & Time Variations

**15-Minute Grace Period for Clock-In/Out Times:**

When an employee clocks in/out, the system compares actual time vs. planned time (from assigned shift):

**Grace period = ±15 minutes (up to but NOT including 16 minutes)**

| Scenario | Planned | Actual | Deviation | Action | Reason Needed? |
|----------|---------|--------|-----------|--------|---|
| Early (within) | 06:00 | 05:47 | 13 min early | Use planned 06:00 | No |
| Early (boundary) | 06:00 | 05:45 | 15 min early | Use planned 06:00 | No |
| Early (outside) | 06:00 | 05:44 | 16 min early | Ask for reason | Yes |
| Late (within) | 06:00 | 06:10 | 10 min late | Use planned 06:00 | No |
| Late (boundary) | 06:00 | 06:15 | 15 min late | Use planned 06:00 | No |
| Late (outside) | 06:00 | 06:16 | 16 min late | Ask for reason | Yes |
| Perfect | 06:00 | 06:00 | 0 min | Use actual 06:00 | No |

**Key:** Exactly 15 minutes is INCLUDED in grace period (no reason needed). 16+ minutes requires reason & approval.

**Example: Employee Planned 6:00 AM, Clocks In 5:45 AM (15 min early)**
```
✓ Within grace period (≤ 15 min)
→ System uses planned start time: 06:00 AM
→ No reason required
→ No shift in hours
```

**Example: Employee Planned 6:00 AM, Clocks In 5:40 AM (20 min early)**
```
⚠️ Outside grace period (> 15 min)
→ System asks for reason at clock-in:
   "You clocked in 20 minutes early. Why?"
   [Text field for reason]
   
→ Employee provides reason (e.g., "Traffic was light")
→ System creates TIME_VARIATION record (pending approval)
→ Actual clock time (5:40 AM) is recorded
→ SHIFT HOURS: 06:00 AM - 15:00 PM (planned) for now
→ Manager must review & approve actual time before hours are finalized
```

**Time Variation Approval Flow:**

1. **Employee clocks in/out outside grace period** → Reason capture + TIME_VARIATION record created (status: pending)
2. **Manager receives notification** → Views pending time variations in dashboard
3. **Manager Reviews:**
   - Employee name, date, shift, planned time, actual time, deviation, reason
   - Can approve or reject
4. **On Approval:**
   - TIME_VARIATION status → approved
   - PUNCH_RECORD uses actual clock time (not planned)
   - Paid hours recalculated with actual times
   - Audit logged
5. **On Rejection:**
   - TIME_VARIATION status → rejected
   - PUNCH_RECORD uses planned times only
   - Employee can appeal or resubmit with different reason

---

### Forgotten Clock-Out (Auto-Checkout)

**Scenario: Employee Forgets to Clock Out**

When an employee doesn't manually clock out by **end of shift + 1 hour**, the system automatically clocks them out:

```
Employee clocked in: 06:00 AM
Planned shift end: 15:00 PM
Auto-checkout trigger: 16:00 PM (1 hour after planned end)

At 16:00 PM (auto-triggered):
  → System auto-generates PUNCH_RECORD
  → punch_out_time = 16:00 PM (automatic)
  → Shift duration: 06:00 - 16:00 = 10 hours
  → Status: "auto_checked_out" (flagged for review)
  → Goes to manager/admin review section (pending approval)
```

**Manager/Admin Review Dashboard:**

Manager sees pending auto-checkouts:
```
AUTO CHECKOUTS PENDING REVIEW:

Employee: John S.
Date: 2026-10-04
Clocked In: 06:00 AM
Auto-Checked Out: 16:00 PM (forgot to clock out)
Planned Shift End: 15:00 PM
Calculated Duration: 10 hours
Status: Pending Review

Actions: [Adjust Time] [Approve As-Is] [Add Note]
```

**Manager Can Adjust Auto-Checkout:**

Manager options:
1. **Adjust Time:** Change the auto-checkout time
   - Example: "Employee actually left at 15:30, not 16:00"
   - System recalculates paid hours + break requirement
   
2. **Approve As-Is:** Accept auto-checkout at 16:00 PM
   - PUNCH_RECORD confirmed
   - Audit logged: "Auto-checkout approved"
   
3. **Add Note:** Manager documents reason
   - "Employee was helping with inventory"
   - "Employee in meeting with guest"

**Employee Notification:**

Employee receives alert:
```
⚠️ You were automatically checked out at 16:00 PM on 2026-10-04
(Planned shift end was 15:00 PM)

Your manager is reviewing this. Please contact them if you left earlier.
```

**Important:**
- Auto-checkout happens **1 hour after planned shift end** (grace period for manager to notice)
- ALL auto-checkouts require manager/admin review before finalization
- Employee can see pending auto-checkouts in their dashboard
- Manager can see manager's notes and decision reason
- All adjustments logged to audit trail with manager name & timestamp

---

### Clock-Out Flow: Break Tracking

**System automatically calculates required break and pre-fills it. Employee confirms or adjusts.**

**Scenario A: Shift ≥ 6 hours (Mandatory Break)**

Employee clocks out at 15:00 (started 6:30 = 8.5 hour shift)

```
System calculation:
  Shift duration: 6:30 → 15:00 = 8 hours 30 minutes
  German law: 8.5 hours = 6-9 hour range = 30 min minimum break
  Paid hours (auto-calculated): 8.5 - 0.5 = 8 hours

Clock-out screen shows (PRE-FILLED):
  "Your shift was 8 hours 30 minutes
   Automatically deducted break: 30 minutes
   Paid hours: 8 hours
   
   Is this correct?"
   
Options:
  ○ Yes, 30 min is correct (CONFIRM)
  ○ Actually I took 45 min
  ○ Actually I took 15 min
  ○ Actually I took: [___] min (manual entry)
  
(Employee confirms or changes)
→ System records actual break taken
→ If actual < required (e.g., 15 min < 30 min): ⚠️ Warning logged
→ If actual > required (e.g., 45 min): Bonus break recorded
→ Paid hours = duration - actual_break_taken (recalculated if changed)
```

**Scenario B: Shift < 6 hours (No Mandatory Break)**

Employee clocks out at 18:30 (started 14:00 = 4.5 hour shift)

```
System calculation:
  Shift duration: 14:00 → 18:30 = 4 hours 30 minutes
  German law: 4.5 hours = <6 hour range = NO mandatory break
  Paid hours (auto-calculated): 4.5 hours (no deduction)

Clock-out screen shows:
  "Your shift was 4 hours 30 minutes
   No break required. You get: 4.5 paid hours
   
   Did you take a break?"
   
Options:
  ○ No break (0 min) — Confirm
  ○ Yes, I took 10 min
  ○ Yes, I took 15 min
  ○ Yes, I took: [___] min (manual entry)
  
(Employee confirms or specifies)
→ System records voluntary break
→ Paid hours = duration - actual_break_taken (if any)
```

### Time Variation & Break Tracking Database

**PUNCH_RECORD Table (Updated):**
```
id | employee_id | hotel_id | shift_date |
PLANNED TIMES (from assigned shift):
  planned_start_time | planned_end_time |
ACTUAL TIMES (from employee clock in/out):
  actual_punch_in_time | actual_punch_out_time |
GRACE PERIOD & VARIATION:
  start_time_variation_minutes (diff: actual vs planned) |
  end_time_variation_minutes (diff: actual vs planned) |
  time_variation_approved (boolean) |
SHIFT CALCULATION:
  shift_duration_minutes (final: based on approved times) |
  required_break_minutes (auto-calculated from duration) |
  actual_break_minutes (employee input at clock-out) |
  paid_hours (duration - break / 60, using approved times) |
  under_break_warning (boolean: actual < required) |
AUTO-CHECKOUT:
  auto_checked_out (boolean: TRUE if system auto-generated checkout) |
  auto_checkout_reviewed (boolean: manager reviewed and approved) |
created_at | updated_at
```

**TIME_VARIATION Table (New):**
```
id | punch_record_id | employee_id | hotel_id |
variation_type ('clock_in_early' | 'clock_in_late' | 'clock_out_early' | 'clock_out_late') |
planned_time | actual_time | variation_minutes |
reason (text: employee provided reason) |
status ('pending' | 'approved' | 'rejected') |
reviewed_by_id (FK manager/admin id) |
review_notes (optional: manager's decision notes) |
created_at | reviewed_at | updated_at
```

**ATTENDANCE_TRACKING Table (New - For Manager Review & Reporting):**
```
id | employee_id | hotel_id | shift_date |
PLANNED vs ACTUAL (for analysis):
  planned_start_time | actual_punch_in_time | clock_in_variation_minutes |
  planned_end_time | actual_punch_out_time | clock_out_variation_minutes |
WITHIN GRACE PERIOD:
  clock_in_within_grace (boolean) | clock_out_within_grace (boolean) |
PUNCH SUMMARY:
  total_shift_duration_minutes | paid_hours |
  required_break_minutes | actual_break_minutes |
  under_break_warning (boolean) |
AUTO-CHECKOUT FLAG:
  was_auto_checked_out (boolean) |
TIME_VARIATION STATUS:
  has_pending_variation (boolean) | variation_status |
created_at | updated_at

Note: This table is populated from PUNCH_RECORD data for easy manager querying.
It allows for quick filtering, sorting, and pattern analysis.
```

**AUDIT_LOG Entry:**
```
action: 'EMPLOYEE_CLOCK_OUT'
resource: 'PUNCH_RECORD'
details: {
  employee_id: 123,
  shift_date: '2026-10-04',
  shift_duration_minutes: 480,
  required_break_minutes: 30,
  actual_break_minutes: 25,
  under_break_warning: true,  // 25 < 30
  paid_hours: 7.583,
  message: "Break under requirement: 25 min vs. 30 min required"
}
timestamp: '2026-10-04T14:35:00Z'
```

### API: Clock-Out Endpoint

**Endpoint:** `POST /employee/punch-out`

**Request (Phase 1):**
```json
{
  "employeeId": 123,
  "punchInTime": "2026-10-04T06:00:00Z",
  "punchOutTime": "2026-10-04T14:35:00Z",
  "shiftDate": "2026-10-04"
}
```

**Response (Auto-Calculated Break, Pre-Filled):**
```json
{
  "status": "awaiting_break_confirmation",
  "punchRecordId": "punch_abc123",
  "shiftData": {
    "shiftDurationMinutes": 515,
    "shiftDurationHours": 8.583,
    "requiredBreakMinutes": 30,
    "requiresBreak": true
  },
  "breakCalculation": {
    "message": "Your shift was 8 hours 35 minutes",
    "requiredBreakMinutes": 30,
    "suggestedBreakMinutes": 30,
    "paidHoursPreFilled": 8.083,
    "paidHoursCalculation": "8.583 - (30/60) = 8.083"
  },
  "breakConfirmation": {
    "question": "Is 30 minutes correct?",
    "predefinedOptions": [
      { "label": "Yes, 30 min is correct", "value": 30, "isDefault": true },
      { "label": "Actually I took 45 min", "value": 45 },
      { "label": "Actually I took 15 min", "value": 15 },
      { "label": "Actually I took 60 min", "value": 60 }
    ],
    "allowManualEntry": true,
    "manualEntryPlaceholder": "Or enter custom: ___ min"
  }
}
```

**Request (Second Step — Employee Confirms or Changes Break):**
```json
{
  "punchRecordId": "punch_abc123",
  "actualBreakMinutes": 30,
  "breakSource": "confirmed" | "adjusted" | "manual"
}
```

**Examples:**
```json
// Employee confirms the pre-filled 30 min
{
  "punchRecordId": "punch_abc123",
  "actualBreakMinutes": 30,
  "breakSource": "confirmed"
}

// Employee says they took more (45 min)
{
  "punchRecordId": "punch_abc123",
  "actualBreakMinutes": 45,
  "breakSource": "adjusted"
}

// Employee manually types a custom amount
{
  "punchRecordId": "punch_abc123",
  "actualBreakMinutes": 25,
  "breakSource": "manual"
}
```

**Response (Final Clock-Out Confirmation):**
```json
{
  "status": "clocked_out",
  "punchRecordId": "punch_abc123",
  "employeeId": 123,
  "paidHours": 8.083,
  "shiftSummary": {
    "shiftDurationHours": 8.583,
    "requiredBreakMinutes": 30,
    "actualBreakMinutes": 30,
    "underBreakWarning": false,
    "paidHoursCalculation": "8.583 - (30/60) = 8.083"
  },
  "nextShift": "2026-10-05 at 06:00 (Tomorrow)",
  "message": "Clocked out successfully. See you tomorrow!"
}
```

### Under-Break Handling

**If Employee Clocks Out with Break < Required:**

```json
{
  "status": "clocked_out_with_warning",
  "punchRecordId": "punch_abc123",
  "underBreakWarning": {
    "triggered": true,
    "requiredMinutes": 30,
    "actualMinutes": 15,
    "shortfall": 15,
    "message": "⚠️ You took 15 min break but 30 min is required by law. This has been logged and will be reviewed."
  },
  "paidHours": 8.25,
  "auditLogged": true
}
```

**Manager Reviews Under-Break Violations:**
- Dashboard shows: "2 employees clocked out with insufficient breaks this week"
- Admin can view audit log: which shifts, how much break taken vs. required, dates
- Optional: Manager/Admin can adjust break time if employee reports it incorrectly

---

### Phase deliverables and test focus

**Milestones:** M1 pilot-ready (end of Phase 2): planning, kiosk punch, approvals, month close, timesheet PDF. M2 compliant (end of Phase 4): rule engine, vacation, sickness, time account. M3 full rollout (end of Phase 7).

**Phase 0 (parallel, 1-2 weeks):** legal and works council confirmation, DPIA screening, EU hosting and processor agreements, rule profile sign-off, pilot hotel chosen. *Test:* signed checklist.

**Phase 1 (6-8 weeks solo, about 4 with two developers):** accounts and role selector, setup wizard, employee + contract onboarding, Excel import (employees, shift templates), planning calendar (week grid, both views, drag and drop, validation, publish, headcount, schedule PDF/Excel), kiosk punch (name + PIN, device registration, offline queue), breaks, grace period, auto-checkout, corrections, unplanned punches, audit log. *Test:* kiosk flow end to end, IDOR across companies, overlap and split-shift rules, break formula edge cases, grid load with 60 employees.

**Phase 2 (3 weeks):** hours tracking and targets, worked-time approval, hours visibility, no-show alerts, month close, timesheet PDF/Excel, attendance reports, optional badge identification and break start/stop. *Test:* approval scopes per role, period lock, visibility setting.

**Phase 3 (2 weeks):** compliance engine (daily/weekly limits, rest period with compensation, Sundays, night work, minors, maternity), override audit, compliance report, hash-chained audit log. *Test:* the two daylight-saving shifts, rule profile overrides.

**Phase 4 (4 weeks):** vacation (BUrlG proration, notices, carryover), sickness on the plan, absence types and comp time, blackouts and minimum staffing, time-account ledger, offboarding and exit statement, documents (admin side). *Test:* proration examples, expiry only after notices, sick-during-vacation refund, ledger totals.

**Phase 5 (3 weeks):** shift and leave wishes, availability, shift swaps, open shifts, qualifications. *Test:* swap eligibility checks, one approved claim per open shift.

**Phase 6 (2-3 weeks):** employee dashboard (PWA with web push), announcements with read confirmation, document access for employees, calendar feed, GDPR data export. *Test:* push delivery, privacy of the team calendar.

**Phase 7 (2 weeks):** payroll export (CSV, DATEV), hour categories, analytics, remaining exports. *Test:* closed periods only, category minutes against hand calculation.

**Phase 8 (deferred):** social network after legal and works council sign-off.

**Phase 9 (optional):** occupancy-based staffing suggestions, auto-fill suggestions, public API, SSO.

---

## Appendix: API Field Naming (camelCase)

### Employment Terms
- targetHoursPerWeek, targetHoursPerMonth
- vacationDaysPerYear, vacationDaysAllocatedThisYear, vacationDaysUsedThisYear, remainingVacationDays
- restVacationDaysPerYear
- getsPublicHoliday
- contractStartDate, contractEndDate
- workingModel

### Schedule & Hours
- paidHoursAssigned (main field for hours on schedule)
- currentWeekHours, currentMonthHours
- weeklyTarget, monthlyTarget
- restPeriodHours (gap between shifts)
- breakDurationMinutes
- startTime, endTime
- durationHours

### Employee Profile
- firstName, lastName
- personalNumber (PIN, returned only once at creation or reset)
- employeeId, userId
- primaryHotelId, primaryDepartmentId

### Time-Off
- startDate, endDate
- timeOffDays
- countsAgainstAllowance, creditsHours, absenceType

### Wishes
- shiftId
- priority (1=high, 2=medium, 3=low)
- requestedAt
- leaveDays

---

## Appendices

The appendices are operational guides written before the final decisions. Where an appendix and the main body disagree, the main body and Resolved Design Decisions win. Known differences: Appendix B (managers see display names, not only IDs); Appendix C and D (vacation proration follows BUrlG, see Legal Compliance Baseline B, not days/365); Appendix F (extra import columns: dateOfBirth, workDaysPerWeek, employmentType, preferredLanguage, monthlyHoursCap, carryoverLimitDays; email optional); Appendix G (break thresholds follow ArbZG § 4 net-time rules; employees are identified by name + PIN); all appendices (every employee gets a user account automatically, there are no account-less employees; PINs are never emailed; sick days are marked on the plan by planners, not requested by employees).


---

## Appendix A: Security Review


**Status:** Pre-Phase 1 Security Assessment  
**Date:** 2026-10-04  
**Scope:** Authentication, Authorization, Data Protection, API Security, Compliance

---

### 1. AUTHENTICATION & PASSWORD SECURITY

#### Current Design
- JWT + refresh tokens ✅
- Email + password login ✅
- Employee personal_number (PIN) for tablet punch ✅

#### Issues Found

##### 🔴 CRITICAL: Password Requirements Not Defined
- No minimum password length specified
- No character complexity rules (uppercase, lowercase, numbers, symbols)
- No password history / reuse prevention
- Risk: Weak passwords, brute force attacks

**Recommendation:**
```
Password Policy (Admin/Manager/Employee):
- Minimum 12 characters (or 10 if symbols required)
- MUST contain: uppercase + lowercase + number + symbol
- No common patterns (123456, password, hotel_name)
- No password history reuse (last 5 passwords)
- Expiration: Optional (German law does not require it for non-critical systems)
- Temporary passwords on first invite MUST expire after 24 hours
```

##### 🟡 MEDIUM: No Account Lockout After Failed Logins
- No protection against brute force / credential stuffing
- Risk: Attacker can try thousands of passwords

**Recommendation:**
```
Implement Account Lockout:
- Lock account after 5 failed attempts (within 15 minutes)
- Lock duration: 15 minutes (auto-unlock)
- Send email alert to user: "Login attempt from IP: xxx"
- Log all failed attempts to audit_log
- Admin can manually unlock
```

##### 🟡 MEDIUM: No Session Timeout
- JWT tokens don't have expiration time
- Risk: Long-lived tokens if device stolen

**Recommendation:**
```
Token Expiration:
- Access token: 15 minutes
- Refresh token: 7 days
- Refresh endpoint: POST /auth/refresh-token (requires valid refresh token)
- Auto-logout on mobile/tablet after 30 minutes inactivity
- Force re-authentication for sensitive actions (delete employee, assign time-off)
```

##### 🟡 MEDIUM: Personal_number (PIN) Security
- PIN used for tablet punch in/out
- No mention of PIN complexity or change frequency
- Risk: Easy to guess, social engineer, or observe

**Recommendation:**
```
PIN Security:
- Minimum 4 digits (unique per employee, per hotel)
- No forced PIN rotation (one PIN per employee; admin reset on request)
- Hash PIN before storage (never store plaintext)
- Lock employee out after 3 failed PIN attempts (15 min)
- Employee can request new PIN via app
- Do NOT display PIN after creation (employee sees it once, must note it)
- Log all PIN changes to audit_log
```

---

### 2. AUTHORIZATION & ROLE-BASED ACCESS CONTROL (RBAC)

#### Current Design
- Three separate tables (EMPLOYEE, MANAGER, ADMIN) ✅
- Role-based permissions defined ✅
- Manager limited to assigned hotels ✅

#### Issues Found

##### 🔴 CRITICAL: No Permission Enforcement Layer Specified
- API design shows endpoints but no middleware to enforce permissions
- Risk: Missing checks can expose data

**Recommendation:**
```
Implement Permission Middleware:
- Every endpoint must check role + assigned resources
- Pattern: requireRole(['admin', 'manager']) → then requireHotel(hotelId)
- Example: GET /manager/schedule?hotelId=1
  - Middleware checks: isManager() → isAssignedToHotel(1)?
  - If false: 403 Forbidden (not 404 — don't leak that hotel exists)

Middleware stack for MANAGER endpoints:
- Authenticate JWT
- Verify role = 'manager'
- Extract hotelId from request (query/body/params)
- Check: hotel_id ∈ MANAGER_HOTEL join table
- If not: return 403 Forbidden
- Proceed only if all checks pass
```

##### 🟡 MEDIUM: No Data Isolation Specified for Multi-Tenant
- App is multi-hotel / multi-company
- Risk: Manager of Hotel A sees Hotel B's data (SQL injection or coding bug)

**Recommendation:**
```
Database-Level Tenant Isolation:
- EVERY query that touches SCHEDULE, SHIFT, DEPARTMENT, EMPLOYEE must filter by hotel_id
- Use database views for each role to enforce isolation:
  - VIEW manager_accessible_schedules: auto-filters to MANAGER_HOTEL
  - Never query SCHEDULE without WHERE hotel_id = ?
  
- Application-level checks:
  - Extract hotel_id from request
  - Verify manager is assigned to that hotel
  - Use parameterized queries (never concatenate IDs)

Example WRONG (SQL injection risk):
```sql
SELECT * FROM schedule WHERE hotel_id = ${hotelId}  -- VULNERABLE
```

Example CORRECT:
```sql
SELECT * FROM schedule WHERE hotel_id = $1  -- Prepared statement
-- Pass [hotelId] as parameter
```
```

##### 🟡 MEDIUM: Manager can create/delete departments without approval
- Manager can create unlimited departments within assigned hotel
- Risk: Confusion, orphaned data, accidentally deleting structure

**Recommendation:**
```
Approve Department Changes (Optional):
- Manager can only EDIT/DELETE departments if they have no scheduled shifts
- If shifts exist: soft block (warning) OR require Admin approval
- Log all department creations/deletions to audit_log

Alternative (Simpler):
- Manager can create departments freely
- Admin has final say on deletion
- Departments are soft-deleted (deleted_at timestamp, not hard delete)
```

---

### 3. DATA ENCRYPTION & STORAGE

#### Issues Found

##### 🔴 CRITICAL: No Encryption Specified for Sensitive Data
- Passwords, PINs, emails stored in database
- Risk: Database breach exposes all sensitive data

**Recommendation:**
```
Encryption at Rest (Database):
- Enable PostgreSQL encryption at rest (pgcrypto)
- Hash passwords: bcrypt (rounds: 12) — NEVER store plaintext
  - Hash PIN with argon2id/bcrypt; verified only after the employee is selected on the kiosk
  - Cost: ~100ms per login (acceptable for security)
  
- Sensitive fields:
  - password_hash: bcrypt
  - pin_hash: argon2id/bcrypt (never display/export)
  - email: plaintext (needed for login + GDPR rights)
  
Database Connection:
- Use SSL/TLS for all PostgreSQL connections (sslmode=require)
- Store DB credentials in environment variables (never hardcode)
- Use connection pooling with maxConnections limit
```

##### 🟡 MEDIUM: Email Addresses Not Encrypted
- Risk: Email enumeration attack (attacker learns which employees exist)

**Recommendation:**
```
Email Privacy:
- Emails are necessary for authentication + GDPR data access
- CANNOT hide them (need to check if email exists on login)
- Mitigation: Rate-limit login attempts by email (already covered above)
- Never expose employee list by email to unauthenticated users
```

##### 🟡 MEDIUM: No Encryption for Sensitive Audit Data
- Audit logs store sensitive actions (time-off, shifts, payments)
- Risk: Admin can see all actions; if audit DB compromised, history exposed

**Recommendation:**
```
Audit Log Encryption (Optional but Recommended):
- Store audit_log details (JSONB) encrypted
- Use AES-256 encryption for audit fields
- Key rotation every 90 days
- Only necessary if high compliance required (GDPR, SOX)
- Simpler: Just ensure access control — only Super-Admin can view audit logs
```

---

### 4. API SECURITY

#### Issues Found

##### 🔴 CRITICAL: No Input Validation Strategy Specified
- Risk: SQL injection, XSS, NoSQL injection, buffer overflow

**Recommendation:**
```
Input Validation (ALL endpoints):

1. Type Checking:
   - hotelId: must be positive integer
   - date: must be ISO 8601 format (YYYY-MM-DD)
   - time: must be HH:MM format
   - email: must be valid email format
   - firstName: max 100 chars, no SQL keywords
   
2. Range Checking:
   - durationHours: 0.5 to 12 (shift cannot be > 12 hours)
   - maxHoursPerWeek: 0 to 60 (sanity check)
   - vacation_days_per_year: 20 to 40 (German legal min/max)
   
3. Use Schema Validation (Joi, Zod, or similar):
```javascript
const createShiftSchema = Joi.object({
  hotelId: Joi.number().integer().positive().required(),
  departmentId: Joi.number().integer().positive().required(),
  name: Joi.string().max(100).required(),
  startTime: Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
  endTime: Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
  breakDurationMinutes: Joi.number().integer().min(0).max(120),
});
```

4. Sanitization:
   - Trim whitespace
   - Remove special characters from names
   - Never allow HTML/script tags in input (inputs are JSON, not HTML, but validate anyway)
   
5. Prepared Statements (PostgreSQL):
   - ALWAYS use parameterized queries
   - Never concatenate user input into SQL
```

##### 🟡 MEDIUM: No CORS Policy Specified
- Risk: Frontend on different origin can be hijacked

**Recommendation:**
```
CORS Configuration:
- Frontend domain: https://attendance-app.example.com
- Admin domain: https://admin.attendance-app.example.com (if separate)
- Tablet domain: https://tablet.attendance-app.example.com (if separate)

Express CORS:
const corsOptions = {
  origin: ['https://attendance-app.example.com', 'https://admin.attendance-app.example.com'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
```

##### 🟡 MEDIUM: No Rate Limiting Specified
- Risk: Brute force, DDoS, API abuse

**Recommendation:**
```
Rate Limiting:
- Login endpoint: 5 requests per 15 minutes per IP
- Punch endpoint: 10 requests per minute per employee
- Schedule endpoint: 100 requests per minute per user
- General API: 1000 requests per hour per user

Use express-rate-limit:
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 5,
  message: 'Too many login attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});
```

##### 🟡 MEDIUM: No CSRF Protection Specified
- Risk: Malicious site tricks user into making requests

**Recommendation:**
```
CSRF Protection:
- Use CSRF tokens for state-changing requests (POST, PUT, DELETE, PATCH)
- Include token in custom header (X-CSRF-Token)
- Validate token on backend before processing

Express middleware:
const csrf = require('csurf');
const csrfProtection = csrf({ cookie: true });
app.post('/schedule', csrfProtection, (req, res) => {
  // Process only if token valid
});

Frontend includes token in every form/request.
```

---

### 5. AUDIT LOGGING & MONITORING

#### Current Design
- AUDIT_LOG table exists ✅
- Soft warnings logged ✅

#### Issues Found

##### 🟡 MEDIUM: Audit Log Details Not Specified
- What events are logged? (not comprehensive)
- Who has access? (not specified)

**Recommendation:**
```
Mandatory Audit Events:
- Login/logout (success + failure)
- Employee creation/deletion/status change
- Manager assignment to hotel (add/remove)
- Shift assignment (create/update/delete)
- Time-off approval/rejection
- Wish approval/rejection
- Arbeitszeitkonto payment (every payment)
- Work target changes
- Department changes
- Public holiday changes
- Failed authorization attempts (403)
- Admin actions (only visible to Admins)

Audit Log Schema (update):
```sql
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  hotel_id INT NOT NULL,
  actor_id INT,  -- User who performed action
  actor_type VARCHAR(20),  -- 'admin' | 'manager' | 'system'
  action VARCHAR(100),  -- e.g., 'employee.created', 'shift.assigned'
  entity_type VARCHAR(50),  -- 'employee', 'shift', 'schedule'
  entity_id INT,  -- ID of affected resource
  old_values JSONB,  -- Previous values (for updates)
  new_values JSONB,  -- New values (for updates/creates)
  status VARCHAR(20),  -- 'success' | 'soft_warning' | 'hard_block'
  ip_address INET,  -- Actor's IP (for security investigation)
  user_agent TEXT,  -- Browser/device info
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Access Control:
- Super-Admin: Can see all audit logs (company-wide)
- Manager: Can see only their hotel's logs (read-only)
- Employee: No access to audit logs
- Audit logs cannot be deleted (immutable)
- Archive old logs (> 1 year) to separate table
```

##### 🟡 MEDIUM: No Alerting for Suspicious Activity
- Risk: Intrusions not detected until later

**Recommendation:**
```
Security Alerts (Email to Admin):
- More than 10 failed login attempts in 1 hour
- Employee created at unusual time (night/weekend)
- Unusual mass shift assignment (> 20 in 1 hour)
- Arbeitszeitkonto payment > 50 hours in 1 month
- Manager assignment to new hotel (track for audit)
- Admin login from new IP address
```

---

### 6. COMPLIANCE & LEGAL

#### German Data Protection (GDPR + BDSG)

##### 🔴 CRITICAL: No Data Retention Policy
- Risk: Violates GDPR Article 5 (data minimization)

**Recommendation:**
```
Data Retention Policy:
- Active employee data: kept as long as employed + 6 months
- Terminated employee data: retained 6 years (German tax law — Aufbewahrungsfrist)
- Punch records: 3 years (German labor law)
- Time-off records: 3 years
- Arbeitszeitkonto: 3 years
- Audit logs: 1 year (archive older logs)

Deletion Strategy:
- Soft delete (deleted_at timestamp) for audit trail
- Hard delete from active tables after retention period
- Archive to separate, encrypted table
```

##### 🔴 CRITICAL: No Data Subject Rights Procedures
- Risk: Cannot comply with GDPR Article 15 (right to access)

**Recommendation:**
```
GDPR Rights Implementation:

1. Right to Access (Article 15):
   - POST /employee/me/data-export → returns JSON of all employee's data
   - Response: personal data, schedules, time-off, arbeitszeitkonto, wishes
   - Available within 30 days
   
2. Right to Erasure (Article 17 — "Right to be Forgotten"):
   - Only applies to terminated employees
   - Can delete: personal_number, phone (if any), emergency contacts
   - CANNOT delete: shifts (history), time-off (legal requirement), audit logs
   
3. Right to Rectification (Article 16):
   - Employee can update own firstName, lastName, email
   - Admin can update any employee data
   
4. Right to Portability (Article 20):
   - Export personal data in CSV/JSON format
   - POST /employee/me/export-csv
```

##### 🟡 MEDIUM: No Privacy Policy or Data Processing Agreement
- Risk: Violates GDPR Article 13 (transparency)

**Recommendation:**
```
Required Documents:
1. Privacy Policy (German + English):
   - What data is collected
   - How it's used
   - Who has access
   - How long it's retained
   - Employee rights (access, delete, portability)
   - Contact for data protection officer
   
2. Data Processing Agreement (if using third-party vendors):
   - SendGrid (email) → DPA required
   - Mailgun (email) → DPA required
   - AWS/hosting provider → DPA required
   
3. Employee Handbook Section:
   - Explain how time tracking works
   - PIN security guidelines
   - Disciplinary actions for PIN sharing
```

##### 🟡 MEDIUM: No Consent Management
- Risk: Cannot demonstrate legal basis for processing

**Recommendation:**
```
Consent Logging:
- Track when employees consent to time tracking
- Get explicit consent for arbeitszeitkonto calculations
- Log consent to audit_log with timestamp + version of policy

Example:
```sql
CREATE TABLE employee_consents (
  id SERIAL PRIMARY KEY,
  employee_id INT NOT NULL,
  consent_type VARCHAR(50),  -- 'time_tracking', 'arbeitszeitkonto', 'data_processing'
  consent_given BOOLEAN,
  policy_version VARCHAR(10),  -- "1.0"
  consented_at TIMESTAMPTZ,
  ip_address INET,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```
```

---

### 7. THIRD-PARTY SERVICE SECURITY

#### Email Services (SendGrid / Mailgun)

##### 🟡 MEDIUM: No API Key Rotation Specified
- Risk: If key leaked, attacker can send emails

**Recommendation:**
```
Email Service Security:
- Store API keys in environment variables only (never commit to repo)
- Use separate API keys for production vs staging
- Rotate keys every 90 days
- Use SendGrid/Mailgun key permissions (restrict to specific IPs)
- Monitor usage: alert if > 1000 emails sent in 1 hour

Email Template Injection:
- Never include user input directly in email templates
- Sanitize employee names, invitation tokens in emails
```

##### 🟡 MEDIUM: Invitation Token Security
- Risk: Tokens could be guessed or leaked

**Recommendation:**
```
Invitation Token Security:
- Generate 32-byte random token (uuid + crypto.randomBytes)
- Hash token before storage in DB: bcrypt(token)
- Token expires after 24 hours (invitation_expires_at)
- One-time use: delete after used
- Send token only via email (not SMS, not displayed in browser)

Example:
```javascript
const token = crypto.randomBytes(32).toString('hex');
const tokenHash = await bcrypt.hash(token, 12);
await saveInvitationToken(employeeId, tokenHash, expiresAt);
// Send email: "Click here: /register?token=<token>"
```
```

---

### 8. INFRASTRUCTURE & DEPLOYMENT SECURITY

#### Issues Found

##### 🟡 MEDIUM: No HTTPS/TLS Specified
- Risk: Credentials transmitted in plaintext

**Recommendation:**
```
Transport Security:
- HTTPS only (TLS 1.3 minimum)
- HSTS header (Strict-Transport-Security: max-age=31536000)
- No mixed content (all resources HTTPS)
- Certificate: Let's Encrypt (free, auto-renewal)

Express Security Headers:
const helmet = require('helmet');
app.use(helmet());  // Adds:
  - Content-Security-Policy
  - X-Frame-Options
  - X-Content-Type-Options
  - X-XSS-Protection
```

##### 🟡 MEDIUM: Database Credentials Management
- Risk: Hardcoded credentials in code = breach risk

**Recommendation:**
```
Environment Variables (.env file):
DB_HOST=localhost
DB_PORT=5432
DB_NAME=attendance_prod
DB_USER=app_user
DB_PASSWORD=<generated-strong-password>
JWT_SECRET=<32-byte-random-string>
SENDGRID_API_KEY=<key>

Never commit .env to Git:
.env
.env.*.local
```

---

### 9. AUTHENTICATION EDGE CASES

#### Issues Found

##### 🟡 MEDIUM: No Password Reset Flow
- Risk: Employee locked out permanently

**Recommendation:**
```
Password Reset Flow:
1. Employee clicks "Forgot Password"
2. Enters email
3. Check: Email exists in EMPLOYEE table
4. Generate reset token (same as invitation token)
5. Send email with reset link (expires 24 hours)
6. Employee clicks link → sets new password
7. Log password reset to audit_log

Security:
- Do NOT confirm if email exists (prevents enumeration)
- Instead: "If email found, reset link sent" (same message always)
- Only 3 reset tokens valid per email per day
```

##### 🟡 MEDIUM: No "Remember Me" Option
- Risk: Employee must log in every time

**Recommendation:**
```
"Remember this device" (Optional):
- Store device_id in secure HTTP-only cookie
- On next login, auto-fill email (but still require password)
- Or: Issue longer-lived refresh token (30 days) for trusted device
- Require email confirmation if login from new device (security email)
```

---

### 10. TABLET/MOBILE SPECIFIC SECURITY

#### Punch In/Out via PIN

##### 🔴 CRITICAL: No Offline Mode Security Specified
- Tablets may work offline (WiFi down in hotel)
- Risk: No authentication if offline → anyone can punch

**Recommendation:**
```
Offline Punch Mode:
- PIN cache (hashed): Store hashed PIN locally for offline use
- Queue punches locally
- Sync when online (mark as offline_punch: true)
- Manager can review offline punches before accepting
- Limit offline punches to 5 per day (then require online)

Offline Punch Record:
```sql
ALTER TABLE punch_record ADD COLUMN (
  offline_punch BOOLEAN DEFAULT FALSE,
  verified_by_id INT,  -- Admin/Manager who verified offline punch
  verified_at TIMESTAMPTZ
);
```
```

##### 🟡 MEDIUM: No Session Security for Tablet
- Risk: Tablet left unlocked = anyone can punch

**Recommendation:**
```
Tablet Session Security:
- Auto-logout after 30 minutes inactivity
- Require PIN + password for sensitive actions (not just PIN for punch)
- Show "Are you sure?" dialog for time-off requests on tablet
- Disable back button (prevent accidental navigation)
- Require biometric (face/fingerprint) on modern tablets + PIN
```

---

### 11. DATABASE SECURITY

#### Issues Found

##### 🟡 MEDIUM: No SQL Injection Prevention Specified
- Risk: Attackers can execute arbitrary SQL

**Recommendation:**
```
Parameterized Queries (ALWAYS):

WRONG:
const query = `SELECT * FROM employees WHERE hotel_id = ${hotelId}`;
db.query(query);  // VULNERABLE

CORRECT:
const query = 'SELECT * FROM employees WHERE hotel_id = $1';
db.query(query, [hotelId]);  // SAFE

Use parameterized queries for ALL database operations.
No string concatenation with user input.
```

##### 🟡 MEDIUM: No Database User Permissions Isolation
- Risk: Database user can read/write anything

**Recommendation:**
```
PostgreSQL Roles (Principle of Least Privilege):

CREATE ROLE app_user LOGIN;
GRANT CONNECT ON DATABASE attendance_db TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;

-- Only grant SELECT/INSERT/UPDATE on specific tables needed
GRANT SELECT, INSERT, UPDATE ON employees TO app_user;
GRANT SELECT, INSERT, UPDATE ON shifts TO app_user;
-- Do NOT grant DELETE (use soft deletes)

-- Deny access to sensitive columns
ALTER TABLE employees ALTER COLUMN password_hash SET PRIVILEGES RESTRICT;

-- Separate read-only role for reports
CREATE ROLE app_readonly;
GRANT CONNECT ON DATABASE attendance_db TO app_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_readonly;
```

---

### 12. BACKUP & DISASTER RECOVERY

#### Issues Found

##### 🟡 MEDIUM: No Backup Strategy
- Risk: Data loss = permanent

**Recommendation:**
```
Backup Strategy:
- Daily backups (automated via AWS RDS or similar)
- Test restore weekly (ensure backups work)
- Keep 30 days of backups
- Store backup encryption key separately from database
- Backup retention: comply with German tax law (6 years for payroll-related data)

Backup Testing:
- Monthly: restore to staging DB and verify integrity
- Test specific scenarios: restore single employee, single month, entire hotel
```

---

### SUMMARY: SECURITY ISSUES BY SEVERITY

#### 🔴 CRITICAL (Must Fix Before Phase 1)
1. Password requirements not defined
2. No input validation strategy
3. No GDPR compliance procedures
4. No data retention policy
5. Permission enforcement layer not specified
6. No encryption strategy

#### 🟡 MEDIUM (Must Fix in Phase 1-2)
1. Account lockout after failed login
2. No session timeout for JWT
3. PIN complexity rules
4. No CORS policy
5. No rate limiting
6. No CSRF protection
7. Audit log access control
8. Password reset flow
9. Offline punch mode for tablets
10. Database user role isolation
11. Backup strategy

#### 🟢 LOW (Nice to Have)
1. Audit log encryption
2. Security alerts
3. Device fingerprinting for login
4. Remember device option

---

### RECOMMENDED SECURITY CHECKLIST FOR PHASE 1

Before launching Phase 1, add these to your code:

- [ ] Password policy (12 chars, uppercase/lowercase/number/symbol)
- [ ] JWT expiration (15 min access, 7 days refresh)
- [ ] Account lockout (5 attempts, 15 min lock)
- [ ] Input validation (schema validation on all endpoints)
- [ ] Parameterized queries (no SQL concatenation)
- [ ] CORS policy defined
- [ ] CSRF protection middleware
- [ ] Rate limiting on auth endpoints
- [ ] Helmet.js security headers
- [ ] HTTPS only (TLS 1.3)
- [ ] Audit logging for all state changes
- [ ] Permission checks on every protected endpoint
- [ ] bcrypt/argon2id for passwords and PINs
- [ ] Environment variables for secrets
- [ ] Privacy policy + GDPR consent form
- [ ] PIN security (hashing, complexity, lockout)

---

### NEXT STEPS

1. **Review** this security assessment
2. **Confirm** which items are non-negotiable for your use case
3. **Prioritize** (must-have vs nice-to-have)
4. **Start Phase 1** with security checklist implemented
5. **Conduct penetration testing** before production launch

Ready to proceed with Phase 1 build?


---

## Appendix B: Data Visibility & Permission Matrix


**Security Principle:** Separation of Concerns
- **Employees** → Own data only
- **Managers** → Hours/operational data (no personal info)
- **Admins** → Employee profiles + personal data (HR)
- **Super-Admins** → Everything

---

### Employee Data Visibility

#### What MANAGER Can See (Hours-Related Only)
```
✅ Can See:
  - Employee ID (identifier)
  - Assigned shifts (dates/times/hours)
  - Worked hours (daily/weekly/monthly)
  - Work targets (targets vs actual)
  - Arbeitszeitkonto balance (overtime hours)
  - Time-off records (which days off, type)
  - Punch in/out times (clock records)
  - Shift wishes (requested shifts)
  - Leave wishes (requested days off)

❌ CANNOT See:
  - First name / Last name
  - Email address
  - Personal number (PIN)
  - Phone number
  - Address
  - Employment contract details
  - Salary/hourly rate
  - Personal notes
  - Emergency contacts
```

#### What ADMIN Can See (Full Profile)
```
✅ Can See:
  - ALL employee personal data
  - First name / Last name
  - Email address
  - Personal number (PIN)
  - Phone number (if stored)
  - Address (if stored)
  - Employment contract details
  - Working model (hourly/salary)
  - Public holiday eligibility
  - All hours-related data
  - Department assignments
  - Hotel assignments
  - Onboarding/invitation status
```

#### What SUPER-ADMIN Can See (Unrestricted)
```
✅ Can See:
  - All employee data (all fields)
  - Manager personal data
  - Admin personal data
  - Company financial data
  - All audit logs
  - System configuration
  - All reports
```

#### What EMPLOYEE Can See (Own Data Only)
```
✅ Can See:
  - Own schedule
  - Own worked hours
  - Own work targets
  - Own arbeitszeitkonto (if salaried)
  - Own time-off balance
  - Own submitted wishes
  - Own punch records

❌ CANNOT See:
  - Other employees' schedules
  - Other employees' hours
  - Other employees' personal info
  - Manager info
  - Admin info
  - Company-level data
```

---

### API Data Responses by Role

#### Employee GET /employee/me
```json
{
  "employeeId": 1,
  "firstName": "Maria",
  "lastName": "Schmidt",
  "email": "maria@hotel.de",
  "status": "active"
}
```

#### Manager GET /manager/employees
```json
[
  {
    "employeeId": 1,
    "assignedHotels": [1, 2],
    "currentWeekHours": 38.5,
    "currentMonthHours": 160,
    "weeklyTarget": 40,
    "monthlyTarget": 160,
    "arbeitszeitkontoBalance": 5.5,
    "remainingVacationDays": 18
  },
  {
    "employeeId": 2,
    "assignedHotels": [1],
    "currentWeekHours": 35.0,
    "weeklyTarget": 40,
    // ... more employees
  }
]
```

**Note:** No firstName/lastName/email returned

#### Admin GET /admin/employees
```json
[
  {
    "employeeId": 1,
    "firstName": "Maria",
    "lastName": "Schmidt",
    "email": "maria@hotel.de",
    "personalNumber": "5729",
    "status": "active",
    "workingModel": "salary",
    "getsPublicHoliday": true,
    "primaryHotel": { "id": 1, "name": "Hotel Downtown" },
    "primaryDepartment": { "id": 5, "name": "Front Desk" },
    "assignedHotels": [1, 2],
    "assignedDepartments": [5, 8],
    "currentWeekHours": 38.5,
    "arbeitszeitkontoBalance": 5.5,
    "remainingVacationDays": 18,
    "createdAt": "2026-09-15T10:00:00Z"
  }
]
```

**Note:** Includes full personal data + hours data

#### Manager GET /manager/schedule?hotelIds=[1,2,3]
```json
{
  "date": "2026-10-05",
  "schedules": [
    {
      "scheduleId": 1,
      "employeeId": 1,
      "hotelId": 1,
      "departmentId": 5,
      "shiftName": "Early Shift",
      "startTime": "06:00",
      "endTime": "14:00",
      "paidHours": 7.5,
      "breakDuration": 30
    },
    {
      "scheduleId": 2,
      "employeeId": 2,
      "hotelId": 1,
      "departmentId": 5,
      "shiftName": "Late Shift",
      "startTime": "14:00",
      "endTime": "22:30",
      "paidHours": 8.0,
      "breakDuration": 30
    }
  ]
}
```

**Note:** Shows employee_id, hours, shift details — NO personal names/emails

---

### Database Query Examples

#### Query: Manager fetches employees (hours-only view)

**CORRECT:**
```sql
SELECT 
  e.employee_id,
  e.primary_hotel_id,
  e.primary_department_id,
  -- Hours-related fields
  (SELECT SUM(paid_hours) FROM schedule 
   WHERE employee_id = e.employee_id 
   AND date >= DATE_TRUNC('week', NOW())
  ) as current_week_hours,
  
  (SELECT balance_hours FROM arbeitszeitkonto 
   WHERE employee_id = e.employee_id
  ) as arbeitszeitkonto_balance,
  
  (SELECT vacation_days_per_year - vacation_days_used_this_year 
   FROM employee_vacation_allowance
   WHERE employee_id = e.employee_id AND year = EXTRACT(YEAR FROM NOW())
  ) as remaining_vacation_days

FROM employee e
JOIN manager_hotel mh ON e.primary_hotel_id = mh.hotel_id
WHERE mh.manager_id = $1
  AND e.primary_hotel_id IN (
    SELECT hotel_id FROM manager_hotel WHERE manager_id = $1
  );

-- NEVER SELECT: first_name, last_name, email, personal_number
```

#### Query: Admin fetches employees (full profile)

**CORRECT:**
```sql
SELECT 
  e.*,  -- ALL fields including email, personal_number, etc.
  (SELECT COUNT(*) FROM schedule WHERE employee_id = e.employee_id) as total_shifts,
  (SELECT SUM(paid_hours) FROM schedule WHERE employee_id = e.employee_id) as total_hours

FROM employee e
JOIN hotel h ON e.primary_hotel_id = h.id
WHERE h.company_id IN (
  SELECT company_id FROM admin_company WHERE admin_id = $1
);

-- CAN SELECT: everything (personal_number, email, etc.)
```

#### Query: Employee fetches own schedule

**CORRECT:**
```sql
SELECT 
  s.schedule_id,
  s.date,
  s.start_time,
  s.end_time,
  (s.end_time - s.start_time - INTERVAL '1 min' * sh.break_duration_minutes) as paid_hours,
  d.name as department_name,
  sh.name as shift_name
  
FROM schedule s
JOIN shift sh ON s.shift_id = sh.id
JOIN department d ON sh.department_id = d.id
WHERE s.employee_id = $1  -- $1 = current user's employee_id
  AND s.date >= CURRENT_DATE;

-- NEVER allow filter by other employee_id
-- Always enforce: s.employee_id = current_user_employee_id
```

---

### Permission Middleware (Code Pattern)

#### Middleware 1: Employee Can Only See Own Data

```javascript
async function requireEmployeeDataAccess(req, res, next) {
  const employeeId = req.user.employee_id;  // From JWT
  const requestedEmployeeId = req.params.employeeId || req.query.employeeId;
  
  // If requesting own data: allow
  if (employeeId === parseInt(requestedEmployeeId)) {
    return next();
  }
  
  // If requesting other employee's data: forbidden
  return res.status(403).json({ 
    error: 'Cannot access other employee data' 
  });
}

// Usage:
@requireEmployeeDataAccess()
GET /employee/:employeeId/schedule
```

#### Middleware 2: Manager Can Only See Hours Data

```javascript
async function managerHoursDataOnly(req, res, next) {
  // Middleware automatically filters queries to hours-only fields
  // If query tries to select personal data, it's stripped
  
  const allowedFields = [
    'employee_id',
    'current_week_hours',
    'current_month_hours',
    'weekly_target',
    'monthly_target',
    'arbeitszeitkonto_balance',
    'remaining_vacation_days',
    'shift_assignments',
    'work_targets'
  ];
  
  const forbiddenFields = [
    'first_name',
    'last_name',
    'email',
    'personal_number',
    'phone',
    'address',
    'password_hash'
  ];
  
  // Add field restrictions to request
  req.visibleFields = allowedFields;
  req.forbiddenFields = forbiddenFields;
  
  next();
}

// Usage:
@requireManager()
@requireHotelAccess()
@managerHoursDataOnly()
GET /manager/employees
```

#### Middleware 3: Admin Can See All Employee Data

```javascript
async function adminFullDataAccess(req, res, next) {
  // Admin gets unrestricted access to employee data
  
  const managerId = req.user.manager_id;  // From JWT
  
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  
  // Mark that this user has full data access
  req.fullDataAccess = true;
  req.visibleFields = 'ALL';  // All fields allowed
  
  next();
}

// Usage:
@requireAdmin()
@requireCompanyAccess()
@adminFullDataAccess()
GET /admin/employees
```

---

### Summary: Data Access by Role

| Data Field | Employee | Manager | Admin | Super-Admin |
|------------|----------|---------|-------|-------------|
| Own Schedule | ✅ | ✅ (as hours) | ✅ | ✅ |
| Own Hours | ✅ | ✅ (all employees) | ✅ | ✅ |
| Other Employees' Hours | ❌ | ✅ | ✅ | ✅ |
| **Personal Data** | | | | |
| Own Name/Email | ✅ | ❌ | ✅ | ✅ |
| Other Employees' Names | ❌ | ❌ | ✅ | ✅ |
| Personal Numbers (PIN) | Own only | ❌ | ✅ | ✅ |
| Contact Info | ❌ | ❌ | ✅ | ✅ |
| **Admin Data** | | | | |
| Manager Info | ❌ | ❌ | Limited | ✅ |
| Admin Info | ❌ | ❌ | Limited | ✅ |
| Company Data | ❌ | ❌ | Assigned Co. | ✅ |
| **Reporting** | | | | |
| Own Dashboard | ✅ | ✅ | ✅ | ✅ |
| Department/Hotel Reports | ❌ | ✅ | ✅ | ✅ |
| Company Reports | ❌ | ❌ | ✅ | ✅ |
| All-Company Reports | ❌ | ❌ | ❌ | ✅ |

---

### Phase 1 Implementation

**These constraints must be enforced in Phase 1:**

```
API Responses:
✅ Implement field filtering per role
✅ Manager endpoints never return personal_number, email, first_name
✅ Employee endpoints only allow access to own employee_id
✅ Admin endpoints return full employee profiles
✅ Super-admin endpoints return all data

Database Queries:
✅ Manager queries never SELECT personal data
✅ Employee queries always filter WHERE employee_id = current_user
✅ Admin queries filter by assigned companies
✅ Super-admin queries have no restrictions

Middleware:
✅ requireEmployeeDataAccess() — enforce own-data-only
✅ requireManagerHoursOnly() — strip personal fields
✅ requireAdminCompanyAccess() — filter by assigned companies
✅ requireSuperAdminAccess() — full access
```

---

### Ready for Phase 1? 🚀

**Final confirmation:**

1. ✅ **Employee**: Own data only (schedule, hours, vacation days)
2. ✅ **Manager**: Hours-related data only (NO names, emails, PINs)
3. ✅ **Admin**: Employee profiles + personal data (for HR/onboarding)
4. ✅ **Super-Admin**: Unrestricted access to everything

All three design questions answered:
- ✅ Single Super-Admin only (manually created)
- ✅ Admin can manage multiple companies (via ADMIN_COMPANY join table)
- ✅ Dashboards show both aggregate + breakdown

**Ready to build Phase 1?** I'll create:
1. PostgreSQL schema (with proper field separation)
2. Express.js backend with middleware
3. Authentication (4 login endpoints)
4. Authorization & data filtering
5. First CRUD endpoints


---

## Appendix C: Vacation Allocation Logic


**Context:** When admin creates an employee on a specific contract start date, the system automatically calculates remaining vacation days for the current year.

---

### Concept: Prorated Vacation

When an employee starts mid-year, they don't get the full 30 days of vacation. The vacation is **prorated** (calculated proportionally) based on how many days remain in the year.

```
Example Scenarios:

Scenario 1: New employee starts Nov 1
├─ Days remaining in 2026: 61 days (Nov 1 - Dec 31)
├─ Annual vacation: 30 days
├─ Prorated: (61 / 365) * 30 = 5.01 → 5 days
└─ This year's allocation: 5 days

Scenario 2: New employee starts Jan 15
├─ Days remaining in 2026: 351 days (Jan 15 - Dec 31)
├─ Annual vacation: 30 days
├─ Prorated: (351 / 365) * 30 = 28.86 → 29 days
└─ This year's allocation: 29 days

Scenario 3: New employee starts Jan 1 (start of year)
├─ Days remaining: 365 days
├─ Annual vacation: 30 days
├─ Prorated: (365 / 365) * 30 = 30 days
└─ This year's allocation: 30 days (full year)

Scenario 4: New employee starts Dec 31 (last day)
├─ Days remaining: 1 day
├─ Annual vacation: 30 days
├─ Prorated: (1 / 365) * 30 = 0.08 → 0 days
└─ This year's allocation: 0 days
```

---

### Admin Onboarding: Vacation Fields

When admin creates an employee, they provide:

#### Required Field
```
vacationDaysPerYear: 30  // Annual entitlement (e.g., 30 days = German standard)
```

#### Optional Override Field
```
vacationDaysAllocatedThisYear: 5  // Admin can override if needed
// If omitted, system auto-calculates based on contract start date
```

---

### Calculation Algorithm

#### Case 1: Auto-Calculate (No Override)

```javascript
// Admin provides NO vacationDaysAllocatedThisYear
POST /admin/employees
{
  contractStartDate: "2026-11-01",
  vacationDaysPerYear: 30
  // vacationDaysAllocatedThisYear: NOT provided
}

// System calculates:
const currentYear = 2026;
const startDate = new Date("2026-11-01");
const endOfYear = new Date("2026-12-31");

const daysRemaining = Math.floor(
  (endOfYear - startDate) / (1000 * 60 * 60 * 24)
) + 1;  // +1 to include start date

const daysInYear = 365;  // or 366 for leap year
const proratedDays = Math.round(
  (daysRemaining / daysInYear) * vacationDaysPerYear
);

// Result: proratedDays = 5

Response:
{
  vacationDaysPerYear: 30,
  vacationDaysAllocatedThisYear: 5,  // Auto-calculated
  vacationDaysUsedThisYear: 0,
  remainingVacationDays: 5
}
```

#### Case 2: Admin Override

```javascript
// Admin provides vacationDaysAllocatedThisYear override
POST /admin/employees
{
  contractStartDate: "2026-11-01",
  vacationDaysPerYear: 30,
  vacationDaysAllocatedThisYear: 10  // Override (e.g., employee carried over 5 extra days)
}

// System uses provided value (no calculation needed)
Response:
{
  vacationDaysPerYear: 30,
  vacationDaysAllocatedThisYear: 10,  // Admin-provided
  vacationDaysUsedThisYear: 0,
  remainingVacationDays: 10
}
```

---

### Database: EMPLOYEE_VACATION_ALLOWANCE

#### Table Schema
```sql
CREATE TABLE employee_vacation_allowance (
  id SERIAL PRIMARY KEY,
  employee_id INT NOT NULL (FK employee.employee_id),
  hotel_id INT NOT NULL (FK hotel.id),
  year INT NOT NULL,  -- 2026, 2027, etc.
  
  vacation_days_per_year INT NOT NULL,         -- Annual entitlement (30)
  vacation_days_allocated_this_year INT,       -- Days available this year (5 or 10)
  vacation_days_used_this_year INT DEFAULT 0,  -- Days used so far
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(employee_id, hotel_id, year)
);
```

#### Created at Employee Onboarding

```
INSERT INTO employee_vacation_allowance
  (employee_id, hotel_id, year, vacation_days_per_year, 
   vacation_days_allocated_this_year, vacation_days_used_this_year)
VALUES 
  (1, 1, 2026, 30, 5, 0);  -- Employee 1 at Hotel 1: 30 days/year, 5 allocated for 2026
```

---

### Remaining Vacation Calculation

**Formula:**
```
remainingVacationDays = vacation_days_allocated_this_year - vacation_days_used_this_year

Example:
  Allocated for 2026: 5 days
  Used so far: 2 days
  Remaining: 5 - 2 = 3 days
```

**API Response:**
```json
GET /employee/me/vacation
{
  "year": 2026,
  "vacationDaysPerYear": 30,
  "vacationDaysAllocatedThisYear": 5,
  "vacationDaysUsedThisYear": 2,
  "remainingVacationDays": 3
}
```

---

### Time-Off Request Validation

When employee requests time-off (annual_leave type):

```javascript
POST /employee/time-off-request
{
  startDate: "2026-11-15",
  endDate: "2026-11-20",
  type: "annual_leave",
  timeOffDays: 4  // 4 business days
}

// Validation:
1. Get vacation allowance for this employee, this year
   SELECT * FROM employee_vacation_allowance 
   WHERE employee_id = 1 AND year = 2026
   → Result: allocated=5, used=2, remaining=3

2. Check if request exceeds remaining days
   IF timeOffDays (4) > remainingVacationDays (3):
     → REJECTED: Insufficient vacation days
     → Message: "You have 3 days remaining, requested 4 days"
   
   ELSE:
     → APPROVED (pending manager approval)
     → On approval: vacation_days_used_this_year += 4
     → New remaining: 3 - 4 = -1 (DEBT BALANCE)
```

---

### New Year: Reset Vacation Balance

At the start of each year (Jan 1), a new EMPLOYEE_VACATION_ALLOWANCE record is created:

```javascript
// Scheduled job runs Jan 1, 2027
FOR EACH active_employee:
  IF employee.contract_end_date IS NULL OR employee.contract_end_date > 2027-01-01:
    
    // Calculate new year's vacation
    newYear = 2027
    startDate = MAX(employee.contract_start_date, 2027-01-01)
    endOfYear = 2027-12-31
    
    daysRemaining = (endOfYear - startDate).days + 1
    proratedDays = ROUND((daysRemaining / 365) * employee.vacation_days_per_year)
    
    INSERT INTO employee_vacation_allowance
      (employee_id, hotel_id, year, vacation_days_per_year, 
       vacation_days_allocated_this_year, vacation_days_used_this_year)
    VALUES 
      (employee.id, employee.primary_hotel_id, 2027, 
       employee.vacation_days_per_year, proratedDays, 0);

Example (Maria from Nov 1, 2026):
  2026: allocated=5, used=2, remaining=3
  2027: allocated=30, used=0, remaining=30 (full year, contract continues)
```

---

### Edge Cases

#### Case 1: Employee Mid-Contract Onboarding

```
Scenario: Maria starts Nov 1, 2026
  Years: 2026-2028 (3-year contract)

At onboarding (Nov 1, 2026):
  2026: allocated=5, used=0

At Jan 1, 2027 (auto-reset):
  2027: allocated=30, used=0  (full year now)

At Jan 1, 2028 (auto-reset):
  2028: allocated=30, used=0  (full year now)
```

#### Case 2: Admin Override for Carryover

```
Scenario: Employee joins from another company, brings 5 unused days

At onboarding (Nov 1, 2026):
  Admin provides: vacationDaysAllocatedThisYear = 10
  (5 prorated + 5 carried over = 10)
  
  2026: allocated=10, used=0, remaining=10
```

#### Case 3: Employee Exceeds Allocation

```
Scenario: Employee has 3 days left, requests 4 days off

Request:
  timeOffDays: 4
  remainingVacationDays: 3

Validation: 4 > 3 → REJECTED
Message: "You have 3 remaining vacation days. Request denied."
```

#### Case 4: Negative Balance (Debt)

```
Scenario: Manager assigns sick leave that employee must repay

Post-assignment:
  vacation_days_used_this_year: 32
  vacation_days_allocated_this_year: 30
  remainingVacationDays: -2  (debt)

Next year:
  automatic reset clears the debt
  2027: allocated=30, used=0, remaining=30
```

---

### Admin Override Scenarios

#### When Admin Might Override Allocated Days

1. **Carryover from Previous Year**
   ```
   Employee had 5 unused days last year
   This year's prorated: 5 days
   Admin sets: 10 days (5 + 5 carried over)
   ```

2. **Special Circumstances**
   ```
   Employee worked unpaid leave last year
   Admin compensates: increases this year's allocation
   ```

3. **Correction**
   ```
   Onboarding system calculated wrong
   Admin corrects manually
   ```

---

### API Responses

#### GET /admin/employees/:id (Admin Creating Employee)

```json
{
  "employeeId": 1,
  "firstName": "Maria",
  "lastName": "Schmidt",
  "email": "maria@hotel.de",
  "contractStartDate": "2026-11-01",
  "contractEndDate": null,
  "workingModel": "salary",
  "targetHoursPerWeek": 40,
  "targetHoursPerMonth": 160,
  "vacationDaysPerYear": 30,
  "vacationDaysAllocatedThisYear": 5,     // ← Auto-calculated or admin-provided
  "vacationDaysUsedThisYear": 0,
  "remainingVacationDays": 5,
  "restVacationDaysPerYear": 2,
  "getsPublicHoliday": true,
  "status": "pending_invite",
  "personalNumber": "5729",
  "invitationExpiresAt": "2026-10-05T10:00:00Z"
}
```

#### GET /employee/me/vacation (Employee View Own Vacation)

```json
{
  "year": 2026,
  "vacationDaysPerYear": 30,
  "vacationDaysAllocatedThisYear": 5,
  "vacationDaysUsedThisYear": 2,
  "remainingVacationDays": 3,
  "restVacationDaysPerYear": 2,
  "pendingTimeOffRequests": [
    {
      "id": 1,
      "startDate": "2026-11-10",
      "endDate": "2026-11-12",
      "days": 2,
      "status": "pending"
    }
  ]
}
```

---

### Implementation Checklist for Phase 1

- [ ] Employee table: add `vacation_days_per_year` field
- [ ] Employee table: add `vacation_days_allocated_this_year_override` (nullable) field
- [ ] Onboarding endpoint: accept `vacationDaysAllocatedThisYear` (optional)
- [ ] Onboarding logic: calculate prorated vacation if not provided
- [ ] Onboarding logic: create EMPLOYEE_VACATION_ALLOWANCE record
- [ ] Employee vacation API: return remaining vacation days
- [ ] Time-off validation: check remaining days before approval
- [ ] Time-off approval: deduct days from vacation_days_used_this_year
- [ ] Scheduled job: auto-reset vacation allowance on Jan 1 (Phase 2)
- [ ] Admin override UI: allow admin to manually set allocated days
- [ ] Audit log: track all vacation allocation changes

---

### Example Workflow

```
1. Admin creates Maria (Nov 1, 2026)
   ├─ vacationDaysPerYear: 30
   ├─ vacationDaysAllocatedThisYear: NOT provided
   ├─ System calculates: 5 days
   └─ EMPLOYEE_VACATION_ALLOWANCE created: (employee_id=1, year=2026, allocated=5)

2. Maria logs in, views vacation
   ├─ GET /employee/me/vacation
   └─ Response: remaining=5 days

3. Maria requests 2 days off (Nov 15-16)
   ├─ POST /employee/time-off-request
   ├─ Validation: 2 <= 5 → APPROVED
   └─ vacation_days_used_this_year: 0 → 2

4. Maria views vacation again
   ├─ GET /employee/me/vacation
   └─ Response: remaining=3 days

5. Jan 1, 2027 (scheduled job)
   ├─ Maria's contract continues
   ├─ New record created: (employee_id=1, year=2027, allocated=30)
   └─ Vacation resets: 30 days available
```

---

### Ready for Phase 1

All vacation logic is documented and ready to implement in Phase 1 onboarding.


---

## Appendix D: Retroactive Onboarding


**Scenario:** Employee has already been working (sometimes for months), but is being entered into the system for the first time (or late).

Admin needs to account for:
1. The employee's actual start date
2. Days already used/taken as vacation
3. Calculate remaining vacation accurately

---

### Real-World Example

**Situation:**
- Maria started working: **January 15, 2026**
- Onboarded into system: **June 4, 2026** (5 months later)
- Annual vacation entitlement: **30 days**
- Vacation days already taken (Jan-May): **5 days**

**Problem:** If system doesn't account for past usage, Maria would show 30 days remaining instead of 25 days.

---

### Onboarding Form Fields

When admin creates Maria in June for January start:

```json
{
  "firstName": "Maria",
  "lastName": "Schmidt",
  "email": "maria@hotel.de",
  
  // Employment terms
  "contractStartDate": "2026-01-15",  // ← ACTUAL start (not June 4)
  "contractEndDate": null,
  "workingModel": "salary",
  "targetHoursPerWeek": 40,
  "targetHoursPerMonth": 160,
  
  // Vacation
  "vacationDaysPerYear": 30,           // Annual entitlement
  "vacationDaysAllocatedThisYear": 30, // Full year (since she started Jan 15)
  "vacationDaysUsedThisYear": 5,       // Already taken Jan-May
  
  "restVacationDaysPerYear": 2,
  "getsPublicHoliday": true,
  
  "primaryHotelId": 1,
  "primaryDepartmentId": 5
}
```

---

### System Calculation

#### Vacation Allocated This Year

```
Employee started Jan 15, current date June 4
vacationDaysPerYear = 30

Option A: Auto-calculate from contract start date
  daysRemainingFromStart = (Dec 31 - Jan 15).days + 1 = 351 days
  allocatedDays = (351 / 365) * 30 = 28.8 → 29 days
  
Option B: Admin override (simpler, just use full year)
  allocatedDays = 30 days (full year entitlement)

→ RECOMMENDED: Use Option B for retroactive
  Admin just enters: vacationDaysAllocatedThisYear = 30
  (Employee started in this year, so gets full allocation)
```

#### Vacation Used This Year

```
Admin enters what Maria already used:
vacationDaysUsedThisYear = 5 days
(This must come from payroll/HR records or manager input)
```

#### Remaining Vacation

```
remainingVacationDays = vacationDaysAllocatedThisYear - vacationDaysUsedThisYear
remainingVacationDays = 30 - 5 = 25 days

Maria has 25 days left for the rest of 2026
```

---

### Response to Admin

```json
{
  "employeeId": 1,
  "firstName": "Maria",
  "lastName": "Schmidt",
  "contractStartDate": "2026-01-15",
  "status": "pending_invite",
  "personalNumber": "5729",
  
  // Vacation Summary
  "vacationDaysPerYear": 30,
  "vacationDaysAllocatedThisYear": 30,
  "vacationDaysUsedThisYear": 5,
  "remainingVacationDays": 25,
  
  "message": "Employee created. Contract date is Jan 15 (retroactive). 25 vacation days remaining this year."
}
```

---

### Scenarios

#### Scenario 1: Started Jan 1 (Full Year)

```
Onboarded in June (after 6 months)
- Contract: Jan 1, 2026
- Annual vacation: 30 days
- Used to date: 3 days
- Allocated: 30 days (full year from Jan 1)
- Remaining: 30 - 3 = 27 days
```

#### Scenario 2: Started March 1

```
Onboarded in June (after 3 months)
- Contract: March 1, 2026
- Annual vacation: 30 days
- Used to date: 2 days
- Allocated: 30 days (full year, employee entitled)
- Remaining: 30 - 2 = 28 days
```

#### Scenario 3: Started September 1 (Late in Year)

```
Onboarded in June... wait, this doesn't make sense
Contract date is AFTER onboarding date?
→ Validation error: contractStartDate cannot be in future
→ Admin must enter actual start date
```

#### Scenario 4: Employee Worked from Previous Year

```
Onboarded in June 2026, but started in Nov 2025
- Contract: Nov 1, 2025
- Annual vacation 2025: 30 days, used 8 days, remaining 22
- Annual vacation 2026: 30 days, used 4 days (Jan-June), remaining 26
- System creates two records:
  - EMPLOYEE_VACATION_ALLOWANCE (2025): allocated=5, used=8, remaining=-3 (overused, carry forward)
  - EMPLOYEE_VACATION_ALLOWANCE (2026): allocated=30, used=4, remaining=26
```

---

### Validation Rules

**When admin submits onboarding form:**

1. ✅ `contractStartDate` must be ≤ today (not future)
2. ✅ `vacationDaysUsedThisYear` must be ≥ 0
3. ✅ `vacationDaysUsedThisYear` ≤ `vacationDaysAllocatedThisYear`
   - Example: If allocated=5 days, cannot mark 6 days used
   - Error: "Cannot mark 6 days used when only 5 are allocated"
4. ✅ `vacationDaysAllocatedThisYear` ≤ `vacationDaysPerYear`
   - Example: If annual is 30, allocated this year cannot exceed 30
   - Error: "Allocated days cannot exceed annual entitlement"
5. ✅ If `contractStartDate` is NOT provided, assume today

---

### Admin UI Workflow

```
Step 1: Admin fills onboarding form
  - Enters contractStartDate: Jan 15, 2026
  - Enters vacationDaysPerYear: 30

Step 2: System shows vacation options
  ┌─────────────────────────────────────────────┐
  │ Vacation Days This Year                     │
  │                                             │
  │ Annual entitlement: 30 days                 │
  │ Days allocated this year: [30] (auto-filled)│
  │ Days already used: [_] (admin enters)       │
  │                                             │
  │ If you know employee used 5 days Jan-May,   │
  │ enter 5 in the "Days already used" field    │
  └─────────────────────────────────────────────┘

Step 3: Admin enters vacation used
  - Days already used: 5
  - System calculates remaining: 30 - 5 = 25

Step 4: Admin submits, system creates employee
  - EMPLOYEE record created
  - EMPLOYEE_VACATION_ALLOWANCE record created:
    - allocated_this_year: 30
    - used_this_year: 5
    - remaining: 25
  - Email sent to Maria with PIN
```

---

### Database Records After Retroactive Onboarding

#### EMPLOYEE table
```sql
INSERT INTO employee VALUES (
  1,                          -- employee_id
  42,                         -- user_id
  1,                          -- primary_hotel_id
  5,                          -- primary_department_id
  'Maria',                    -- first_name
  'Schmidt',                  -- last_name
  'maria@hotel.de',           -- email
  '5729',                     -- personal_number (PIN)
  '...',                      -- password_hash (NULL until registration)
  'pending_invite',           -- status
  '...',                      -- invitation_token
  '2026-06-05T00:00:00+02',   -- invitation_expires_at
  'salary',                   -- working_model
  40.0,                       -- target_hours_per_week
  160.0,                      -- target_hours_per_month
  30,                         -- vacation_days_per_year
  '2026-01-15',               -- contract_start_date (retroactive)
  NULL,                       -- contract_end_date
  2,                          -- created_by_id (admin_id)
  '2026-06-04T10:00:00+02',   -- created_at
  '2026-06-04T10:00:00+02'    -- updated_at
);
```

#### EMPLOYEE_VACATION_ALLOWANCE table
```sql
INSERT INTO employee_vacation_allowance VALUES (
  1,                          -- id
  1,                          -- employee_id
  1,                          -- hotel_id
  2026,                       -- year
  30,                         -- vacation_days_per_year
  30,                         -- vacation_days_allocated_this_year (full year)
  5,                          -- vacation_days_used_this_year (already taken Jan-May)
  '2026-06-04T10:00:00+02',   -- created_at
  '2026-06-04T10:00:00+02'    -- updated_at
);
```

---

### Employee View (After Maria Registers)

```
GET /employee/me/vacation

Response:
{
  "year": 2026,
  "vacationDaysPerYear": 30,
  "vacationDaysAllocatedThisYear": 30,
  "vacationDaysUsedThisYear": 5,
  "remainingVacationDays": 25,
  "restVacationDaysPerYear": 2
}
```

Maria sees 25 days remaining (correct!)

---

### Time-Off Request Validation

When Maria tries to request time-off later:

```
POST /employee/time-off-request
{
  "startDate": "2026-06-10",
  "endDate": "2026-06-12",
  "type": "annual_leave",
  "timeOffDays": 3
}

Validation:
1. Get current vacation allowance for Maria, 2026
   → allocated=30, used=5, remaining=25
   
2. Check if request exceeds remaining
   → 3 days ≤ 25 days → ALLOWED
   
3. On approval, update:
   → vacation_days_used_this_year: 5 → 8
   → remaining: 25 - 3 = 22
```

---

### Bulk Retroactive Onboarding

**Scenario:** Hotel was operating manually for 6 months, now adding all 50 employees to system.

**Process:**
1. Admin exports list: employee name, start date, vacation used to date
2. Admin creates each employee one by one:
   - contractStartDate: actual start (Feb 1, Mar 15, etc.)
   - vacationDaysUsedThisYear: days already taken
3. System calculates remaining for each

---

### Validation Error Examples

```
Error 1: Past vacation exceeds allocated
─────────────────────────────────────────
Form input:
  vacationDaysAllocatedThisYear: 10
  vacationDaysUsedThisYear: 12

Error: "Cannot mark 12 days used when only 10 are allocated"
Solution: Admin must increase allocated or decrease used

Error 2: Allocated exceeds annual
─────────────────────────────────────
Form input:
  vacationDaysPerYear: 30
  vacationDaysAllocatedThisYear: 35

Error: "Allocated days (35) cannot exceed annual entitlement (30)"
Solution: Admin must decrease allocated to ≤ 30

Error 3: Contract date in future
─────────────────────────────────
Form input:
  contractStartDate: 2026-08-01 (today is June 4)

Error: "Contract start date cannot be in the future"
Solution: Admin must enter actual start date from past
```

---

### Implementation Checklist for Phase 1

- [ ] Employee table: add `vacation_days_used_this_year` field
- [ ] Onboarding endpoint: accept `vacationDaysUsedThisYear` (optional, default 0)
- [ ] Validation: `vacationDaysUsedThisYear` ≤ `vacationDaysAllocatedThisYear`
- [ ] Validation: `vacationDaysAllocatedThisYear` ≤ `vacationDaysPerYear`
- [ ] Validation: `contractStartDate` ≤ today
- [ ] Onboarding response: show calculated remaining days
- [ ] EMPLOYEE_VACATION_ALLOWANCE: create record with used + allocated
- [ ] Employee API: return remaining vacation days (allocated - used)
- [ ] Time-off validation: check remaining days before approval
- [ ] Admin UI: field for "vacation days already used"

---

### Ready for Phase 1

Retroactive onboarding is fully supported:
1. Admin enters actual contract start date (even if months ago)
2. Admin enters vacation already used (from HR records)
3. System calculates remaining accurately
4. Employee sees correct balance when registered

Example response:
```json
{
  "message": "Employee created. Started Jan 15 (retroactive). Used 5 days so far. 25 vacation days remaining."
}
```


---

## Appendix E: Arbeitszeitkonto Onboarding


**When:** Admin creates a salary employee and needs to set their starting overtime balance

**Why:** Retroactive onboarding, migrating from previous tracking system, or accounting for accumulated overtime before system launch

---

### Overview

- **Arbeitszeitkonto** = overtime account (only for salary workers)
- **Balance** can be positive (employee is owed hours) or negative (employee owes hours)
- **During onboarding**, admin sets the starting balance
- **After onboarding**, balance accumulates/decreases with worked hours and overtime payments

---

### Scenarios

#### Scenario 1: New Hire (No Prior Overtime)

**Admin onboarding form:**
```json
{
  "firstName": "Klaus",
  "lastName": "Weber",
  "email": "klaus@hotel.de",
  "workingModel": "salary",
  "contractStartDate": "2026-11-01",
  "targetHoursPerWeek": 40,
  "targetHoursPerMonth": 160,
  "vacationDaysPerYear": 30,
  "arbeitszeitkontoBalance": 0  // New employee, no prior overtime
}
```

**System creates:**
- ARBEITSZEITKONTO record: balance_hours = 0
- Klaus starts with zero overtime balance

---

#### Scenario 2: Employee Promoted from Hourly to Salary

**Context:** Klaus was hourly (no arbeitszeitkonto), now promoted to salary mid-contract

**Payroll records show:** Klaus worked 5 extra hours last month that would have been overtime, but wasn't paid out (instead goes to account)

**Admin onboarding form:**
```json
{
  "firstName": "Klaus",
  "lastName": "Weber",
  "email": "klaus@hotel.de",
  "workingModel": "salary",  // Changed from 'hourly'
  "contractStartDate": "2026-01-15",
  "targetHoursPerWeek": 40,
  "targetHoursPerMonth": 160,
  "vacationDaysPerYear": 30,
  "arbeitszeitkontoBalance": 5.0  // 5 hours carry forward from hourly period
}
```

**System creates:**
- ARBEITSZEITKONTO record: balance_hours = 5.0
- Klaus starts with +5 hours owed to him

---

#### Scenario 3: Retroactive Onboarding with Tracked Overtime

**Context:** Employee worked Jan-Nov (11 months), now being added to system for the first time

**HR's manual records:**
- Target: 40h/week = 160h/month
- Jan: worked 165h → +5h
- Feb: worked 160h → 0h
- Mar: worked 158h → -2h
- Apr-Nov: worked on target (0h each month)

**Accumulated balance:** 5 + 0 + (-2) + 0+0+0+0+0+0 = **+3 hours**

**Admin onboarding form:**
```json
{
  "firstName": "Maria",
  "lastName": "Schmidt",
  "email": "maria@hotel.de",
  "workingModel": "salary",
  "contractStartDate": "2026-01-15",
  "targetHoursPerWeek": 40,
  "targetHoursPerMonth": 160,
  "vacationDaysPerYear": 30,
  "vacationDaysAllocatedThisYear": 30,
  "vacationDaysUsedThisYear": 5,
  "arbeitszeitkontoBalance": 3.0  // +3h from manual tracking
}
```

**System creates:**
- EMPLOYEE_VACATION_ALLOWANCE: allocated=30, used=5, remaining=25
- ARBEITSZEITKONTO: balance_hours = 3.0
- Maria starts with 3 hours of accumulated overtime

---

#### Scenario 4: Migration from Old System with Undertime

**Context:** Old attendance system tracked balance, being migrated to new system

**Old system showed:** Employee has -4.5 hours (undertime, owes company 4.5 hours)

**Admin onboarding form:**
```json
{
  "firstName": "Hans",
  "lastName": "Mueller",
  "email": "hans@hotel.de",
  "workingModel": "salary",
  "contractStartDate": "2025-06-01",
  "targetHoursPerWeek": 40,
  "targetHoursPerMonth": 160,
  "vacationDaysPerYear": 30,
  "arbeitszeitkontoBalance": -4.5  // Negative = undertime (owes company)
}
```

**System creates:**
- ARBEITSZEITKONTO: balance_hours = -4.5
- Hans starts with -4.5 hours (undertime)

**Going forward:**
- If Hans works extra: balance increases (e.g., +8h work → -4.5 + 8 = +3.5h)
- If Hans works undertime: balance decreases (e.g., -2h work → -4.5 - 2 = -6.5h)

---

#### Scenario 5: Hourly Worker (No Arbeitszeitkonto)

**Admin onboarding form:**
```json
{
  "firstName": "Petra",
  "lastName": "Richter",
  "email": "petra@hotel.de",
  "workingModel": "hourly",  // Not salary
  "contractStartDate": "2026-01-01",
  "targetHoursPerWeek": 30,
  "targetHoursPerMonth": 120,
  "vacationDaysPerYear": 25,
  "arbeitszeitkontoBalance": 5.0  // Ignored (hourly worker)
}
```

**System creates:**
- EMPLOYEE (hourly)
- NO ARBEITSZEITKONTO record (ignored)
- Petra works hourly, overtime paid directly, no account tracking

---

### Database Records

#### Salary Employee (Klaus) — New Hire

**EMPLOYEE row:**
```sql
INSERT INTO employee VALUES (
  1,                          -- employee_id
  42,                         -- user_id
  1,                          -- primary_hotel_id
  5,                          -- primary_department_id
  'Klaus',                    -- first_name
  'Weber',                    -- last_name
  'klaus@hotel.de',           -- email
  '7391',                     -- personal_number
  '...',                      -- password_hash
  'pending_invite',           -- status
  'salary'                    -- working_model
);
```

**ARBEITSZEITKONTO row:**
```sql
INSERT INTO arbeitszeitkonto VALUES (
  1,                          -- konto_id
  1,                          -- employee_id (Klaus)
  1,                          -- hotel_id
  0.0,                        -- balance_hours (NEW HIRE)
  '2026-11-01 10:00:00+01',   -- last_updated
  1                           -- year_of_balance (implicit from last_updated)
);
```

---

#### Salary Employee (Maria) — Retroactive Onboarding

**ARBEITSZEITKONTO row:**
```sql
INSERT INTO arbeitszeitkonto VALUES (
  3,                          -- konto_id
  5,                          -- employee_id (Maria)
  1,                          -- hotel_id
  3.0,                        -- balance_hours (MIGRATED FROM MANUAL TRACKING)
  '2026-11-15 10:00:00+01',   -- last_updated
  1                           -- year
);
```

---

#### Hourly Employee (Petra) — No Arbeitszeitkonto

**EMPLOYEE row:**
```sql
INSERT INTO employee VALUES (
  10,                         -- employee_id
  50,                         -- user_id
  1,                          -- primary_hotel_id
  6,                          -- primary_department_id
  'Petra',                    -- first_name
  'Richter',                  -- last_name
  'petra@hotel.de',           -- email
  '2847',                      -- personal_number
  '...',                      -- password_hash
  'pending_invite',           -- status
  'hourly'                    -- working_model
);

-- NO ARBEITSZEITKONTO record for Petra
```

---

### API Response Examples

#### New Salary Hire Response

```json
{
  "employeeId": 1,
  "firstName": "Klaus",
  "lastName": "Weber",
  "email": "klaus@hotel.de",
  "personalNumber": "7391",
  "status": "pending_invite",
  "workingModel": "salary",
  "contractStartDate": "2026-11-01",
  "targetHoursPerWeek": 40,
  "targetHoursPerMonth": 160,
  "vacationDaysPerYear": 30,
  "vacationDaysAllocatedThisYear": 5,
  "remainingVacationDays": 5,
  "arbeitszeitkontoBalance": 0.0,  // NEW HIRE
  "invitationExpiresAt": "2026-11-02T10:00:00Z",
  "createdAt": "2026-11-01T10:00:00Z"
}
```

#### Retroactive Salary Employee Response

```json
{
  "employeeId": 5,
  "firstName": "Maria",
  "lastName": "Schmidt",
  "email": "maria@hotel.de",
  "personalNumber": "5729",
  "status": "pending_invite",
  "workingModel": "salary",
  "contractStartDate": "2026-01-15",
  "targetHoursPerWeek": 40,
  "targetHoursPerMonth": 160,
  "vacationDaysPerYear": 30,
  "vacationDaysAllocatedThisYear": 30,
  "vacationDaysUsedThisYear": 5,
  "remainingVacationDays": 25,
  "arbeitszeitkontoBalance": 3.0,  // MIGRATED FROM MANUAL TRACKING
  "invitationExpiresAt": "2026-11-02T10:00:00Z",
  "createdAt": "2026-10-04T10:00:00Z"
}
```

#### Hourly Employee Response

```json
{
  "employeeId": 10,
  "firstName": "Petra",
  "lastName": "Richter",
  "email": "petra@hotel.de",
  "personalNumber": "2847",
  "status": "pending_invite",
  "workingModel": "hourly",
  "contractStartDate": "2026-01-01",
  "targetHoursPerWeek": 30,
  "targetHoursPerMonth": 120,
  "vacationDaysPerYear": 25,
  "vacationDaysAllocatedThisYear": 25,
  "remainingVacationDays": 25,
  "arbeitszeitkontoBalance": null,  // HOURLY WORKER: NO ARBEITSZEITKONTO
  "invitationExpiresAt": "2026-11-02T10:00:00Z",
  "createdAt": "2026-10-04T10:00:00Z"
}
```

---

### Later Access — Employee Dashboard

Once Maria registers and logs in:

**GET /employee/me/arbeitszeitkonto**

```json
{
  "employeeId": 5,
  "hotelId": 1,
  "balanceHours": 3.0,
  "interpretation": "+3.0 hours (company owes you 3 hours)",
  "lastUpdated": "2026-10-04T10:00:00Z"
}
```

If Klaus logs in:

```json
{
  "employeeId": 1,
  "hotelId": 1,
  "balanceHours": 0.0,
  "interpretation": "No overtime balance",
  "lastUpdated": "2026-11-01T10:00:00Z"
}
```

---

### Validation Rules

**During Onboarding:**

```
IF workingModel = 'salary':
  arbeitszeitkontoBalance can be:
    - Positive (e.g., +12.5) = company owes employee hours
    - Negative (e.g., -3.0) = employee owes company hours
    - Zero or omitted = no prior balance
    - Must be numeric (DECIMAL)
    
ELSE (workingModel = 'hourly'):
  arbeitszeitkontoBalance is ignored
  No ARBEITSZEITKONTO record created
```

---

### Use Cases

| Scenario | arbeitszeitkontoBalance | Notes |
|----------|------------------------|-------|
| Brand new hire | 0 (or omit) | No prior overtime |
| Retroactive onboarding | 3.0 | From HR manual tracking |
| Promotion hourly→salary | 5.0 | Carryover from hourly period |
| Migration from old system | -4.5 | Has undertime |
| Hourly worker | null/ignored | No tracking |
| Mid-year contract change | varies | Admin sets based on records |

---

### Implementation Checklist for Phase 1

- [ ] Add `arbeitszeitkontoBalance` field to POST /admin/employees request (optional)
- [ ] Add validation: arbeitszeitkontoBalance ignored if workingModel='hourly'
- [ ] On employee creation:
  - [ ] If workingModel='salary' AND arbeitszeitkontoBalance provided:
    - [ ] CREATE ARBEITSZEITKONTO record with that balance
  - [ ] If workingModel='salary' AND arbeitszeitkontoBalance omitted:
    - [ ] CREATE ARBEITSZEITKONTO record with balance=0
  - [ ] If workingModel='hourly':
    - [ ] Skip ARBEITSZEITKONTO creation
- [ ] Include arbeitszeitkontoBalance in onboarding response
- [ ] Phase 4: Add endpoints to view/edit arbeitszeitkonto balance

---

### Ready for Phase 1

Arbeitszeitkonto initialization is fully supported:
1. Admin can set starting balance during onboarding
2. Only for salary workers (hourly workers ignored)
3. Can be positive (company owes) or negative (employee owes)
4. Useful for retroactive onboarding + system migration


---

## Appendix F: Excel Import Guide


**Last Updated:** October 4, 2026  
**For:** Admin Users  
**Purpose:** Import multiple employees at once via Excel spreadsheet

---

### Quick Start

1. **Download the template:** `/admin/employees/import-template`
2. **Fill in employee data** following the column specifications below
3. **Upload the file:** POST to `/admin/employees/import`
4. **Review errors** (if any) and resubmit

---

### Excel File Requirements

| Requirement | Rule |
|-------------|------|
| **Format** | .xlsx (Excel 2007 or later) |
| **Max Size** | 10 MB |
| **Max Rows** | 5,000 rows (header + data) |
| **Encoding** | UTF-8 |
| **Header Row** | Row 1 — must match column names exactly |
| **Data Rows** | Start at row 2 |

---

### Column Specifications

#### Column A: firstName
- **Required:** Yes
- **Type:** Text
- **Length:** 1-100 characters
- **Format:** Any
- **Example:** `Maria`, `José`, `李明`
- **Validation:** Trimmed automatically; empty cells rejected

#### Column B: lastName
- **Required:** Yes
- **Type:** Text
- **Length:** 1-100 characters
- **Format:** Any
- **Example:** `Schmidt`, `García`, `王`
- **Validation:** Trimmed automatically; empty cells rejected

#### Column C: email
- **Required:** Yes
- **Type:** Text (email format)
- **Format:** RFC 5322 compliant
- **Example:** `maria.schmidt@hotel.de`, `support+admin@company.com`
- **Validation:** 
  - Must be valid email format
  - Must be unique in system (no duplicates across all employees)
  - Cannot be a duplicate within the same import file
- **Note:** Email is the login credential; ensure it's correct before import

#### Column D: primaryHotelId
- **Required:** Yes
- **Type:** Integer (positive number)
- **Format:** No decimals
- **Example:** `1`, `5`, `42`
- **Validation:** 
  - Must be > 0
  - Must exist in HOTEL table
  - Hotel must be assigned to your admin account
- **Note:** This is the employee's main hotel; they can be assigned to others later

#### Column E: primaryDepartmentId
- **Required:** Yes
- **Type:** Integer (positive number)
- **Format:** No decimals
- **Example:** `1`, `5`, `12`
- **Validation:**
  - Must be > 0
  - Must exist in DEPARTMENT table
  - Department must belong to the primaryHotelId specified in column D
- **Note:** Cross-hotel department assignments are NOT allowed during onboarding

#### Column F: workingModel
- **Required:** Yes
- **Type:** Text (one of two fixed values)
- **Valid Values:** `hourly` OR `salary` (case-insensitive)
- **Example:** `salary`, `Hourly`, `SALARY`
- **Validation:**
  - Case-insensitive (converted to lowercase)
  - Trimmed of whitespace
  - Any other value rejected
- **Note:** Determines if overtime account (arbeitszeitkonto) is created

#### Column G: contractStartDate
- **Required:** Yes
- **Type:** Date
- **Format:** `YYYY-MM-DD` (ISO 8601) OR Excel native date
- **Example:** `2026-11-01`, `2026-01-15`
- **Validation:**
  - Must be a valid date
  - Must be ≤ today (cannot be future)
  - Retroactive dates allowed (e.g., employee started in January, onboarded in October)
- **Use Case:** 
  - New hire: Use their actual start date
  - Retroactive: Use the date they actually began work (for vacation/hours calculations)

#### Column H: contractEndDate
- **Required:** No (Optional)
- **Type:** Date or empty
- **Format:** `YYYY-MM-DD` (ISO 8601) OR Excel native date OR leave blank
- **Example:** `2027-12-31`, (blank), `2026-12-31`
- **Validation:**
  - If provided, must be ≥ contractStartDate
  - If provided, must be a valid date
- **Meaning:**
  - Blank/empty = ongoing contract (no end date)
  - Future date = fixed-term contract ending on that date
- **Use Case:** Temporary workers, contractors, seasonal staff

#### Column I: targetHoursPerWeek
- **Required:** No (Optional)
- **Type:** Decimal number
- **Range:** 0-168
- **Format:** Use `.` as decimal separator (e.g., `40`, `35.5`, `20.25`)
- **Example:** `40`, `35.5`, `20`
- **Validation:**
  - If provided: 0-168 (hours/week)
  - Can be combined with targetHoursPerMonth or stand alone
- **Behavior:**
  - If only this is provided → system auto-calculates monthly: value × 4.3333
  - If combined with targetHoursPerMonth → both stored as-is
  - Leave blank if no hour targets (casual/flexible workers)
- **Use Case:** Full-time (40), part-time (20), varied hours (35.5)

#### Column J: targetHoursPerMonth
- **Required:** No (Optional)
- **Type:** Decimal number
- **Range:** 0-744
- **Format:** Use `.` as decimal separator (e.g., `160`, `140.75`, `80`)
- **Example:** `160`, `140.75`, `80`
- **Validation:**
  - If provided: 0-744 (hours/month)
  - Can be combined with targetHoursPerWeek or stand alone
- **Behavior:**
  - If only this is provided → system auto-calculates weekly: value ÷ 4.3333
  - If combined with targetHoursPerWeek → both stored as-is
  - Leave blank if no hour targets
- **Use Case:** Contracts defined by monthly hours (common in Germany)

**Hours Targeting Rules:**
| Scenario | Result |
|----------|--------|
| Both blank | No hour targets; no warnings during shift planning; no overtime accumulation |
| Only weekly | Monthly auto-calculated (value × 4.3333) |
| Only monthly | Weekly auto-calculated (value ÷ 4.3333) |
| Both provided | Both stored as-is (custom ratio allowed) |

#### Column K: vacationDaysPerYear
- **Required:** Yes
- **Type:** Decimal number
- **Range:** 0-365
- **Format:** Use `.` as decimal separator (e.g., `30`, `25.5`, `20`)
- **Example:** `30`, `25`, `20.5`
- **Validation:**
  - Must be > 0 (typically)
  - Max 365
- **Meaning:** Annual vacation entitlement for the employee
- **Use Case:** 
  - Germany (legal minimum): 20 (4 weeks)
  - Common in hotels: 25-30 days
  - Senior staff: 30-35 days
- **Note:** No defaults — admin must specify per contract

#### Column L: vacationDaysAllocatedThisYear
- **Required:** No (Optional)
- **Type:** Decimal number
- **Format:** Use `.` as decimal separator
- **Example:** `30`, `5`, `15.5`
- **Validation:**
  - If provided: ≤ vacationDaysPerYear
- **Behavior:**
  - If **blank:** System auto-prorates based on contractStartDate and today's date
    - Example: Start Nov 1, vacation = 30/year → allocated = (61 days remaining / 365) × 30 = ~5 days
  - If **provided:** Admin-override; use this value as the allocated amount
- **Use Cases:**
  - **New hire (normal):** Leave blank → auto-prorated
  - **Retroactive (hired Jan, onboarded June):** Provide 30 → full year allocation
  - **Carryover from previous employer:** Provide 35 → gives 30 + 5 carryover

#### Column M: vacationDaysUsedThisYear
- **Required:** No (Optional)
- **Type:** Decimal number
- **Format:** Use `.` as decimal separator
- **Example:** `5`, `0`, `2.5`
- **Validation:**
  - If provided: ≤ vacationDaysAllocatedThisYear
- **Behavior:**
  - If **blank:** Assumed 0 (no vacation used yet)
  - If **provided:** Admin specifies days already used
- **Use Case:** Retroactive onboarding — employee already took vacation Jan-June, need to record 5 days used
- **Calculation:** Remaining = vacationDaysAllocatedThisYear − vacationDaysUsedThisYear

#### Column N: restVacationDaysPerYear
- **Required:** No (Optional)
- **Type:** Decimal number
- **Range:** 0-30
- **Format:** Use `.` as decimal separator
- **Example:** `2`, `5`, `0`
- **Validation:**
  - If provided: 0-30
- **Meaning:** Extra vacation days (carryover, special grant, compensation, etc.)
- **Use Case:** 
  - Employee rollovers 5 unused days from last year → provide `5`
  - Manager grants 2 extra days as bonus → provide `2`
  - No extra days → leave blank or provide `0`

#### Column O: getsPublicHoliday
- **Required:** No (Optional)
- **Type:** Boolean
- **Valid Values:** 
  - `TRUE`, `True`, `true`, `1`, `YES`, `Yes`, `Y` → Yes
  - `FALSE`, `False`, `false`, `0`, `NO`, `No`, `N` → No
  - Blank → default `TRUE`
- **Example:** `TRUE`, `1`, `YES`, `false`
- **Meaning:** Whether employee receives paid public holiday hours
- **Behavior:**
  - If **YES (salary workers):** Public holiday hours → arbeitszeitkonto (company owes time)
  - If **YES (hourly workers):** Public holiday shifts marked as paid
  - If **NO:** Public holidays not automatically paid; manager assigns as needed
- **Default:** TRUE (most employees get public holidays)

#### Column P: arbeitszeitkontoBalance
- **Required:** No (Optional)
- **Type:** Decimal number (can be positive or negative)
- **Range:** -999 to +999
- **Format:** Use `.` as decimal separator; use `-` for negative (e.g., `-3`, `+12.5`, `0`)
- **Example:** `0`, `+3.5`, `-2`, `12.25`
- **Validation:**
  - Only applies if workingModel='salary'
  - Ignored entirely for hourly workers
  - Range: -999 to +999 hours
- **Meaning:**
  - **+12.5:** Company owes employee 12.5 hours (employee has extra time)
  - **-3.0:** Employee owes company 3 hours (employee has time deficit)
  - **0 (or blank):** No starting balance (most common for new hires)
- **Use Cases:**
  - **New salary hire:** Leave blank or provide `0`
  - **Retroactive (from manual HR records):** Provide actual balance (e.g., `+5.25` if records show employee earned 5.25 hours)
  - **System migration:** Provide balance from old system
  - **Promotion (hourly→salary):** Provide carryover hours

**Important:** Ignored for hourly workers. If column P has a value but workingModel='hourly', the value is silently discarded.

---

### Example Excel File

**Scenario:** Import 3 new employees + 1 retroactive + 1 part-time casual

| firstName | lastName | email | primaryHotelId | primaryDepartmentId | workingModel | contractStartDate | contractEndDate | targetHoursPerWeek | targetHoursPerMonth | vacationDaysPerYear | vacationDaysAllocatedThisYear | vacationDaysUsedThisYear | restVacationDaysPerYear | getsPublicHoliday | arbeitszeitkontoBalance |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Maria | Schmidt | maria.schmidt@hotel.de | 1 | 5 | salary | 2026-11-01 | | 40 | | 30 | | | | TRUE | |
| Klaus | Weber | klaus.weber@hotel.de | 1 | 5 | salary | 2026-01-15 | | | 160 | 30 | 30 | 5 | | TRUE | 3.5 |
| Petra | Casual | petra.casual@hotel.de | 1 | 6 | hourly | 2026-06-15 | | | | 25 | | | | FALSE | |
| John | Contract | john.contract@hotel.de | 2 | 8 | salary | 2026-10-01 | 2026-12-31 | 20 | | 20 | | | 5 | TRUE | 0 |
| Sarah | Flex | sarah.flex@hotel.de | 1 | 7 | hourly | 2026-08-01 | | | | 20 | 15 | 2 | | FALSE | |

**Row 1 (Maria):**
- New hire, full-time salary, starts Nov 1
- 40 hours/week → system calculates ~173.3/month
- 30 vacation days/year → system prorates to ~5 for Nov-Dec
- No balance specified → assumes 0

**Row 2 (Klaus):**
- Retroactive: Started Jan 15, being onboarded in October
- Salary, 160 hours/month (→ ~36.9/week)
- Full 30 days vacation allocated this year, already used 5 → 25 remaining
- +3.5 hours on overtime account (from HR records)

**Row 3 (Petra):**
- Hourly, part-time, no hour targets
- 25 vacation days/year (standard for hourly in Germany)
- No public holidays
- arbeitszeitkontoBalance ignored (hourly worker)

**Row 4 (John):**
- Salary, fixed-term contract (Oct 1 – Dec 31, 2026)
- 20 hours/week (part-time)
- 20 vacation days/year + 5 rest days (carryover)
- 0 overtime balance at start

**Row 5 (Sarah):**
- Hourly, flexible worker
- Started Aug 1, prorated vacation
- Already used 2 days by October → 13 remaining (15 allocated – 2 used)
- No public holidays

---

### Common Errors & How to Fix

| Error | Cause | Solution |
|-------|-------|----------|
| "Email already exists" | Email in file is already in system | Change email or mark employee as inactive |
| "primaryHotelId not found" | Hotel ID doesn't exist or you don't have access | Check correct hotel ID from dropdown |
| "primaryDepartmentId not found" | Department doesn't exist or not in that hotel | Verify department exists and is assigned to hotel |
| "vacationDaysUsedThisYear > allocated" | Used more days than allocated | Reduce used days OR increase allocated |
| "contractEndDate before contractStartDate" | End date is earlier than start | Fix date order |
| "Invalid email format" | Email doesn't follow RFC 5322 | Correct email format (e.g., `user@domain.com`) |
| "targetHoursPerWeek out of range" | Value > 168 | Use 0-168 (max 24/7) |
| "Missing required field: firstName" | Column A is empty | Enter first name |

---

### Dry Run (Validation Only)

Before committing to a full import, test with **dry run mode**:

**Request:**
```
POST /admin/employees/import
Content-Type: multipart/form-data

file: [your-file.xlsx]
dryRun: true
```

**Response:**
- Same format as full import
- Shows all validation errors
- **No records created**
- No emails sent

Fix errors in Excel and resubmit.

---

### Upload & Processing

**Upload File:**
```bash
curl -X POST https://api.example.com/admin/employees/import \
  -H "Authorization: Bearer {token}" \
  -F "file=@employees.xlsx" \
  -F "dryRun=false"
```

**Response (< 100 rows):**
```json
{
  "status": "import_complete",
  "summary": {
    "totalRows": 5,
    "successful": 5,
    "failed": 0,
    "skipped": 0
  },
  "createdEmployees": [
    { "id": 101, "email": "maria.schmidt@hotel.de", "personalNumber": "5729" },
    ...
  ]
}
```

**Response (≥ 100 rows):**
```json
{
  "status": "processing",
  "jobId": "import_20261004_1234567890",
  "message": "Large import queued. Check status with: GET /admin/imports/{jobId}"
}
```

**Check Status (large imports):**
```bash
curl -H "Authorization: Bearer {token}" \
  https://api.example.com/admin/imports/import_20261004_1234567890
```

---

### After Import

#### Employees Receive:

1. **Invitation Email** (within minutes)
   - Registration link (expires in 24 hours)
   - (v3.0: the PIN is NOT included; it is handed over separately)
   - Employment summary (hours, vacation, start date)

2. **How They Activate:**
   - Click registration link
   - Set password
   - Status changes: `pending_invite` → `active`
   - Can now log in and clock in/out

#### Admin Can:

- View all imported employees in dashboard
- Reassign departments later
- Adjust vacation balances anytime
- View import audit log

---

### Tips & Best Practices

✅ **DO:**
- Download template from system — ensures correct headers
- Test with dry run first for large imports
- Use consistent date format (YYYY-MM-DD)
- Review error CSV if any rows fail
- Keep backup of imported file for audit purposes
- Use realistic vacation numbers (25-30 for full-time)

❌ **DON'T:**
- Manually edit headers — must match exactly
- Use future dates for contractStartDate
- Mix date formats (stick to YYYY-MM-DD)
- Overwrite vacation numbers without reason
- Import duplicate emails — system will reject
- Use unsupported Excel versions (needs .xlsx, not .xls)

---

### Support

**Questions?**
- Check validation error message (specifies which row/field failed)
- Download error CSV for detailed feedback
- Contact support with jobId for large import issues

**File Size Issues?**
- Max 10 MB per file
- Max 5000 rows per file
- Split large imports into multiple files if needed


---

## Appendix G: Break Tracking UX


**For:** Tablet/mobile employee interface  
**Trigger:** Employee taps "Clock Out" button  
**Purpose:** Record actual break taken (required by German law)

---

### Scenario A: Shift ≥ 6 Hours (Mandatory Break)

Example: **Start 6:30 AM → End 3:00 PM (8.5 hours)**

#### Screen 1: Pre-Filled Break + Confirmation

```
╔═══════════════════════════════════════════════════════════════╗
║                       CLOCK OUT                               ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  ✓ Clocked In:  06:30 AM                                     ║
║  ✓ Clocking Out: 03:00 PM                                    ║
║  Shift Duration: 8 hours 30 minutes                          ║
║                                                               ║
║  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ║
║                                                               ║
║  ✓ Auto-deducted break: 30 minutes (German law)             ║
║  ✓ Your paid hours: 8 hours                                 ║
║                                                               ║
║  Is this correct?                                            ║
║                                                               ║
║  ┌─────────────────────────────────────────────────────────┐ ║
║  │ ◉ Yes, 30 min is correct ← DEFAULT                      │ ║
║  │ ○ Actually I took 45 min                                │ ║
║  │ ○ Actually I took 15 min                                │ ║
║  │ ○ Actually I took 60 min                                │ ║
║  │ ○ Custom: [___] min ← Can type different amount         │ ║
║  └─────────────────────────────────────────────────────────┘ ║
║                                                               ║
║           [  CONFIRM CLOCK OUT  ] [  CANCEL  ]               ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
```

**Key Difference:**
- ✅ Pre-calculates break automatically (30 min)
- ✅ Pre-calculates paid hours automatically (8 hours)
- ✅ Employee just confirms "Yes" or adjusts
- ✅ Much faster & cleaner UX

#### User Interaction:
1. Employee sees pre-filled "30 min is correct" (already selected)
2. Can confirm or tap another option to change
3. Taps "CONFIRM CLOCK OUT"

#### Screen 2: Confirmation (Success - When Employee Confirms Default)

```
╔═══════════════════════════════════════════════════════════════╗
║                    ✓ CLOCKED OUT                              ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  Shift Summary:                                              ║
║  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ║
║                                                               ║
║  Total Duration:     8 hours 35 minutes                      ║
║  Break Taken:        30 minutes                              ║
║  Paid Hours:         8 hours 5 minutes                       ║
║                                                               ║
║  Status: ✓ Break meets requirement                           ║
║                                                               ║
║  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ║
║                                                               ║
║  Next Shift: Tomorrow (2026-10-05) at 06:00                 ║
║                                                               ║
║  Have a great day! 👋                                        ║
║                                                               ║
║              [  HOME  ]  [  SCHEDULE  ]                       ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
```

#### Screen 2 Alternative (Under-Break Warning)

**If employee enters 15 min (less than required 30 min):**

```
╔═══════════════════════════════════════════════════════════════╗
║                    ⚠ CLOCKED OUT (WITH NOTICE)               ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  Shift Summary:                                              ║
║  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ║
║                                                               ║
║  Total Duration:     8 hours 35 minutes                      ║
║  Break Taken:        15 minutes                              ║
║  Paid Hours:         8 hours 20 minutes                      ║
║                                                               ║
║  ⚠️ WARNING: Break Under Requirement                         ║
║  You took 15 min, but 30 min is required by law.             ║
║  This has been logged and reviewed by management.            ║
║                                                               ║
║  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ║
║                                                               ║
║  Next Shift: Tomorrow (2026-10-05) at 06:00                 ║
║                                                               ║
║              [  HOME  ]  [  SCHEDULE  ]                       ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
```

---

### Scenario B: Shift < 6 Hours (No Mandatory Break)

#### Screen 1: Shift Summary + Optional Break

```
╔═══════════════════════════════════════════════════════════════╗
║                       CLOCK OUT                               ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  Shift Duration: 4 hours 30 minutes                          ║
║  ✓ Clocked In: 14:00                                        ║
║  Clocking Out: 18:30                                        ║
║                                                               ║
║  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ║
║                                                               ║
║  ℹ️ No break is legally required for shifts < 6 hours        ║
║                                                               ║
║  Did you take a break?                                       ║
║                                                               ║
║  ┌─────────────────────────────────────────────────────────┐ ║
║  │ ○ No break (0 min)                                      │ ║
║  │ ○ 10 min                                                │ ║
║  │ ○ 15 min                                                │ ║
║  │ ○ 20 min                                                │ ║
║  │ ○ Other: [___] min ← Can type custom value              │ ║
║  └─────────────────────────────────────────────────────────┘ ║
║                                                               ║
║           [  CONFIRM CLOCK OUT  ] [  CANCEL  ]               ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
```

#### Screen 2: Confirmation (Success)

```
╔═══════════════════════════════════════════════════════════════╗
║                    ✓ CLOCKED OUT                              ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  Shift Summary:                                              ║
║  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ║
║                                                               ║
║  Total Duration:     4 hours 30 minutes                      ║
║  Break Taken:        10 minutes                              ║
║  Paid Hours:         4 hours 20 minutes                      ║
║                                                               ║
║  Status: ✓ No mandatory break required                       ║
║                                                               ║
║  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ║
║                                                               ║
║  You're all set! See you next time.                          ║
║                                                               ║
║              [  HOME  ]  [  SCHEDULE  ]                       ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
```

---

### Scenario C: 9+ Hour Shift (45 Min Mandatory Break)

#### Screen 1: Extended Break Requirement

```
╔═══════════════════════════════════════════════════════════════╗
║                       CLOCK OUT                               ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  Shift Duration: 10 hours 15 minutes                         ║
║  ✓ Clocked In: 06:00                                        ║
║  Clocking Out: 16:15                                        ║
║                                                               ║
║  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ║
║                                                               ║
║  🔴 Required Break: 45 minutes (German law - shifts 9+ hrs)  ║
║                                                               ║
║  How much break did you actually take?                       ║
║  (Can be split, e.g., 15 + 15 + 15 min)                     ║
║                                                               ║
║  ┌─────────────────────────────────────────────────────────┐ ║
║  │ ○ 45 min (meets requirement)                            │ ║
║  │ ○ 60 min                                                │ ║
║  │ ○ 90 min                                                │ ║
║  │ ○ Other: [___] min ← Can type custom value              │ ║
║  └─────────────────────────────────────────────────────────┘ ║
║                                                               ║
║           [  CONFIRM CLOCK OUT  ] [  CANCEL  ]               ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
```

---

### Mobile Layout (Responsive)

#### Vertical Stack (Portrait Mode - Phone)

```
┌───────────────────────────┐
│      CLOCK OUT            │
├───────────────────────────┤
│                           │
│  Shift: 8h 35min          │
│  Required Break: 30min    │
│                           │
│  How much break?          │
│                           │
│  [30 min            ]     │
│  [45 min            ]     │
│  [60 min            ]     │
│  [Other: [20]  min  ]     │
│                           │
│  [CONFIRM] [CANCEL]       │
│                           │
└───────────────────────────┘
```

---

### Break Options Configuration

**System Admin Can Customize Predefined Options:**

```json
{
  "breakOptions": {
    "lessThan6Hours": [0, 10, 15, 20, 30],
    "sixTo9Hours": [30, 45, 60],
    "nineHoursPlus": [45, 60, 90]
  },
  "allowCustomEntry": true,
  "customEntryRange": [0, 120]  // 0-120 minutes
}
```

**Default options based on German law, but customizable per hotel/company.**

---

### Error Scenarios

#### Error 1: Employee Tries to Clock Out Without Entering Break

```
╔═══════════════════════════════════════════════════════════════╗
║  ⚠️ Please Select a Break Amount                              ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  You must specify how much break you took before clocking    ║
║  out. Please select an option or enter a custom amount.      ║
║                                                               ║
║              [  OK  ]                                         ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
```

#### Error 2: Invalid Manual Entry (e.g., 150 minutes for 8h shift)

```
╔═══════════════════════════════════════════════════════════════╗
║  ⚠️ Invalid Break Amount                                      ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  Break cannot exceed shift duration!                         ║
║  Your shift was 8h 35min. Max break: 120 minutes.            ║
║                                                               ║
║  Please enter a value between 0 and 120 minutes.             ║
║                                                               ║
║              [  OK  ]                                         ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
```

---

### Manager Dashboard: Under-Break Violations

```
╔═══════════════════════════════════════════════════════════════╗
║          MANAGER DASHBOARD - BREAK VIOLATIONS                 ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  This Week: 3 employees clocked out with insufficient breaks ║
║                                                               ║
║  Date      | Employee | Duration | Required | Actual | Gap   ║
║  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ║
║  2026-10-04│ John S.  │  8h 30m  │ 30 min   │ 15 min │ -15   ║
║  2026-10-03│ Maria K. │ 10h 00m  │ 45 min   │ 30 min │ -15   ║
║  2026-10-02│ Klaus W. │  6h 30m  │ 30 min   │ 20 min │ -10   ║
║                                                               ║
║  [View Details] [Export] [Print]                             ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
```

**Action:** Manager can click employee name to:
- View full shift details
- Adjust recorded break (if employee reported it wrong)
- Add note for HR/compliance
- Flag for pattern review

---

### API Response Examples

#### Example 1: 8-Hour Shift (6:30-15:00), Employee Confirms Default "30 min"

**Step 1 Request:**
```json
POST /employee/punch-out
{
  "employeeId": 123,
  "punchInTime": "2026-10-04T06:30:00Z",
  "punchOutTime": "2026-10-04T15:00:00Z",
  "shiftDate": "2026-10-04"
}
```

**Step 1 Response (Auto-Calculated, Pre-Filled):**
```json
{
  "status": "awaiting_break_confirmation",
  "punchRecordId": "punch_20261004_123_abc",
  "shiftData": {
    "shiftDurationMinutes": 510,
    "shiftDurationHours": 8.5,
    "requiredBreakMinutes": 30,
    "requiresBreak": true
  },
  "breakCalculation": {
    "message": "Your shift was 8 hours 30 minutes",
    "requiredBreakMinutes": 30,
    "suggestedBreakMinutes": 30,
    "paidHoursPreFilled": 8.0,
    "paidHoursCalculation": "8.5 - (30/60) = 8.0"
  },
  "breakConfirmation": {
    "question": "Is 30 minutes correct?",
    "predefinedOptions": [
      { "label": "Yes, 30 min is correct", "value": 30, "isDefault": true },
      { "label": "Actually I took 45 min", "value": 45 },
      { "label": "Actually I took 15 min", "value": 15 },
      { "label": "Actually I took 60 min", "value": 60 }
    ],
    "allowManualEntry": true,
    "manualEntryPlaceholder": "Or enter custom: ___ min"
  }
}
```

**Step 2 Request (Employee Confirms Default):**
```json
POST /employee/punch-out/confirm-break
{
  "punchRecordId": "punch_20261004_123_abc",
  "actualBreakMinutes": 30,
  "breakSource": "confirmed"
}
```

**Step 2 Response:**
```json
{
  "status": "clocked_out",
  "punchRecordId": "punch_20261004_123_abc",
  "employeeId": 123,
  "shiftDate": "2026-10-04",
  "shiftSummary": {
    "punchInTime": "06:00",
    "punchOutTime": "14:35",
    "shiftDurationMinutes": 515,
    "shiftDurationHours": 8.583,
    "requiredBreakMinutes": 30,
    "actualBreakMinutes": 30,
    "underBreakWarning": false,
    "paidHoursCalculation": "8.583 - 0.5 = 8.083",
    "paidHours": 8.083
  },
  "nextShift": {
    "date": "2026-10-05",
    "time": "06:00",
    "message": "See you tomorrow!"
  },
  "auditLogged": true
}
```

#### Example 2: Same Shift (8.5h), Employee Says They Took Only "15 min" (Under-Break Violation)

**Step 1 Request:** (Same as Example 1)

**Step 1 Response:** (Same as Example 1 — system pre-fills with 30 min required)

**Step 2 Request (Employee Changes to 15 min):**
```json
POST /employee/punch-out/confirm-break
{
  "punchRecordId": "punch_20261004_123_abc",
  "actualBreakMinutes": 15,
  "breakSource": "adjusted"
}
```

**Step 2 Response (with warning):**
```json
{
  "status": "clocked_out_with_warning",
  "punchRecordId": "punch_20261004_124_xyz",
  "employeeId": 124,
  "shiftDate": "2026-10-04",
  "shiftSummary": {
    "punchInTime": "06:00",
    "punchOutTime": "14:35",
    "shiftDurationHours": 8.583,
    "requiredBreakMinutes": 30,
    "actualBreakMinutes": 15,
    "underBreakWarning": true,
    "breakShortfall": 15,
    "warningMessage": "⚠️ You took 15 min break but 30 min is required by law. This has been logged.",
    "paidHours": 8.333
  },
  "auditLogged": true,
  "auditDetails": {
    "action": "EMPLOYEE_CLOCK_OUT_UNDER_BREAK",
    "shortfall_minutes": 15,
    "timestamp": "2026-10-04T14:35:00Z"
  }
}
```

---

### Implementation Notes

1. **Accessibility:** Large buttons, clear text, high contrast for tablet use
2. **Offline Support:** Store clock-out data locally if connection drops, sync when online
3. **Timeout:** Auto-submit after 2 minutes of inactivity (to prevent forgotten submissions)
4. **Biometric (Optional):** Can add fingerprint confirmation before final clock-out
5. **Notifications:** Send manager push notification for significant under-break violations
6. **Internationalization:** Text can be localized; break rules configurable by country


---

## Document History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | Oct 4, 2026 | Initial specification |
| 2.0 | Oct 4, 2026 | Consolidated master, 8 design decisions, MANAGER/MANAGER_HOTEL fix |
| 2.1 | Oct 4, 2026 | Worked-time approval, hours-visibility setting, shift planning by all staff roles |
| 3.0 | Oct 4, 2026 | Final: German legal baseline (rule profiles, ArbZG/BUrlG/EFZG/JArbSchG/MuSchG), actual-time records, employment + contract model, vacation notices, time-account ledger, split shifts, DST-safe timestamps, kiosk redesign (name + PIN, device registration), corrections, period close, payroll export, data protection and works council section, sickness marked on the plan by planners (no sick request in the app), social feed deferred |
| 3.1 | Oct 4, 2026 | Shift planning calendar section (employee/shift views, + menu, absences, drag and drop, headcount), `shift_staffing_requirement`, schedule versioning, unpaid-leave target rule |
| 3.2 | Oct 4, 2026 | Product Concept section (replaces the old overview), Data Import & Export catalogue (7 imports, 12+ exports), export_job and calendar_feed tables, generic import pipeline |
| 3.3 | Oct 4, 2026 | Feature review against the market: coverage matrix, swaps and open shifts, availability, qualifications, absence-type table incl. comp time, blackouts, documents, offboarding, announcements, recording options, hour categories, analytics, optional occupancy-based staffing; old phase checklists replaced by realistic plan with milestones |
| 3.4 | Oct 4, 2026 | Automatic user account and employee role at onboarding (email or generated username, one-time activation code, account reuse by email); employee status active from creation |

**Next steps:** Phase 0 (legal confirmation) in parallel with Phase 1: PostgreSQL migrations -> Express skeleton + auth -> onboarding -> schedule -> kiosk.
