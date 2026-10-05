-- M11 Hours (backlog): manual time-account ledger entries, hour categories, rule profiles, feature toggles.

-- The ledger lines target / worked / absence credit are derived from approved data on read; only manual lines
-- (corrections, payouts) are stored.
CREATE TABLE arbeitszeitkonto_entry (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  entry_date DATE NOT NULL,
  entry_type VARCHAR(20) NOT NULL CHECK (entry_type IN ('correction','payout')),
  hours DECIMAL(6,2) NOT NULL,                     -- signed: a payout is negative
  note TEXT NOT NULL,
  created_by_user_id INTEGER NOT NULL REFERENCES user_account(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_azk_entry_employee ON arbeitszeitkonto_entry (employee_id, entry_date);

-- Hour categories: windows that produce payroll-ready minutes. No wage calculation.
CREATE TABLE hour_category (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES company(id),             -- NULL = system default
  code VARCHAR(30) NOT NULL,
  name VARCHAR(100) NOT NULL,
  rule JSONB NOT NULL,   -- {"daily":{"from":"23:00","to":"06:00"}} | {"weekday":7} | {"holiday":true} | {"dates":["12-24","12-31"],"from":"14:00","to":"24:00"}
  active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX uq_hour_category ON hour_category (COALESCE(company_id, 0), code);
-- the system defaults (night, Sunday, holiday, 24/31 December from 14:00) live in packages/rules (DEFAULT_CATEGORIES);
-- a company row with the same code overrides one, `active = false` switches it off for that company.

CREATE TABLE punch_record_category_minutes (
  punch_record_id INTEGER NOT NULL REFERENCES punch_record(id),
  category_code VARCHAR(30) NOT NULL,
  minutes INTEGER NOT NULL,
  PRIMARY KEY (punch_record_id, category_code)
);

-- Working-time rules as data. Values may only be stricter than the statutory baseline (validated by the API).
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
ALTER TABLE hotel ADD COLUMN rule_profile_id INTEGER REFERENCES rule_profile(id);

-- Feature toggles per company (a missing row means enabled)
CREATE TABLE company_feature (
  company_id INTEGER NOT NULL REFERENCES company(id),
  feature VARCHAR(30) NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_by_user_id INTEGER REFERENCES user_account(id),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (company_id, feature)
);
