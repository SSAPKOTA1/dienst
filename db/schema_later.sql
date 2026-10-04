-- schema_later.sql: NOT applied in v1. Reference for backlog features (see docs/full-spec.md).
-- Apply only after schema_v1.sql.


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

ALTER TABLE hotel ADD COLUMN rule_profile_id INTEGER REFERENCES rule_profile(id);   -- optional override of company profile
