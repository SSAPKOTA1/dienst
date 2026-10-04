-- schema_v1.sql: tables used by the v1 build (see SPEC.md). Run on PostgreSQL 16.
-- Columns marked 'unused in v1' exist for later phases; do not implement their features.

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
  totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending_invite',   -- pending_invite, active, disabled
  invitation_token_hash VARCHAR(255),      -- hash of the invitation token or one-time activation code
  invitation_expires_at TIMESTAMPTZ,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
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

-- Rotating refresh tokens (opaque random token, only the hash is stored)
CREATE TABLE refresh_token (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user_account(id),
  token_hash CHAR(64) NOT NULL UNIQUE,
  active_role VARCHAR(12) NOT NULL,
  active_employee_id INTEGER,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE company (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  grace_period_minutes INTEGER NOT NULL DEFAULT 15,
  retention_months INTEGER NOT NULL DEFAULT 36,          -- legal minimum for time records is 24
  schedule_change_notice_days INTEGER NOT NULL DEFAULT 4,
  sick_backdate_days INTEGER NOT NULL DEFAULT 7,         -- how far back managers may mark sick days on the plan
  pin_length SMALLINT NOT NULL DEFAULT 6 CHECK (pin_length BETWEEN 4 AND 8),
  managers_can_see_phone BOOLEAN NOT NULL DEFAULT FALSE,
  team_absence_visibility VARCHAR(10) NOT NULL DEFAULT 'none' CHECK (team_absence_visibility IN ('none','names_only')),
  swap_approval VARCHAR(15) NOT NULL DEFAULT 'manual' CHECK (swap_approval IN ('manual','auto_if_valid')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by_id INTEGER NOT NULL REFERENCES super_admin(super_admin_id)
);

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

-- employee = ONE EMPLOYMENT at ONE company. Vacation entitlement and the time account belong to
-- the employee row, not to a hotel. Contract terms live in employee_contract (effective-dated).
CREATE TABLE employee (
  employee_id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user_account(id),  -- created automatically at onboarding
  company_id INTEGER NOT NULL REFERENCES company(id),
  primary_hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  primary_department_id INTEGER NOT NULL REFERENCES department(id),
  personnel_number VARCHAR(20) NOT NULL,                 -- generated per company, e.g. P100
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
  opening_balance_hours DECIMAL(7,2) NOT NULL DEFAULT 0,  -- time account at contract start / migration (salary workers)
  contract_start_date DATE NOT NULL,
  contract_end_date DATE,
  created_by_id INTEGER NOT NULL REFERENCES admin(admin_id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, company_id),
  UNIQUE (company_id, personnel_number)
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
  working_weekdays SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}',   -- ISO weekdays 1=Mon..7=Sun; used to count absence days
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

-- Snapshot of a published week, used to show changes since the last publication and to revert drafts
CREATE TABLE schedule_snapshot (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  week_start DATE NOT NULL,                              -- local Monday
  snapshot JSONB NOT NULL,                               -- [{employeeId, shiftId, date, start, end, plannedBreakMinutes}]
  published_by_user_id INTEGER NOT NULL REFERENCES user_account(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_snapshot_hotel_week ON schedule_snapshot (hotel_id, week_start, published_at DESC);

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
 ('vocational_school','Vocational school (Berufsschule)',FALSE,TRUE,FALSE,FALSE,FALSE,TRUE),
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
  decided_by_user_id INTEGER REFERENCES user_account(id),   -- set when a request is approved or rejected
  decided_at TIMESTAMPTZ,
  decision_note VARCHAR(300),
  counts_against_allowance BOOLEAN NOT NULL,
  credits_hours BOOLEAN NOT NULL DEFAULT FALSE,          -- TRUE for annual_leave, sick_leave, public_holiday (salary workers)
  created_by_user_id INTEGER NOT NULL REFERENCES user_account(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (end_date >= start_date)
);
ALTER TABLE schedule ADD CONSTRAINT fk_schedule_time_off FOREIGN KEY (time_off_id) REFERENCES time_off(id);

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
