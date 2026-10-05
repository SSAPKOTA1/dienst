-- M12 Collaboration (backlog): swaps, open shifts, qualifications, availability, documents, announcements,
-- questions to management, feed, calendar feed, offboarding.
ALTER TABLE employee ADD COLUMN terminated_at TIMESTAMPTZ, ADD COLUMN termination_reason TEXT;

CREATE TABLE shift_swap_request (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  schedule_id INTEGER NOT NULL REFERENCES schedule(id),
  requester_employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  counterpart_employee_id INTEGER REFERENCES employee(employee_id),   -- NULL = offered to anyone eligible
  counterpart_schedule_id INTEGER REFERENCES schedule(id),            -- set for a 1:1 swap, NULL for a giveaway
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','accepted_by_peer','approved','rejected','cancelled','expired')),
  reason VARCHAR(300),
  decided_by_user_id INTEGER REFERENCES user_account(id),
  decided_by_role VARCHAR(12),
  decided_at TIMESTAMPTZ,
  decision_note VARCHAR(300),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_swap_status ON shift_swap_request (hotel_id, status);

CREATE TABLE open_shift (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  department_id INTEGER NOT NULL REFERENCES department(id),
  shift_id INTEGER REFERENCES shift(id),
  shift_date DATE NOT NULL,
  planned_start TIMESTAMPTZ NOT NULL,
  planned_end TIMESTAMPTZ NOT NULL,
  planned_break_minutes INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE qualification (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company(id),
  name VARCHAR(100) NOT NULL,
  has_expiry BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (company_id, name)
);
CREATE TABLE employee_qualification (
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  qualification_id INTEGER NOT NULL REFERENCES qualification(id),
  valid_until DATE,
  PRIMARY KEY (employee_id, qualification_id)
);
ALTER TABLE shift ADD COLUMN required_qualification_id INTEGER REFERENCES qualification(id);

CREATE TABLE employee_availability (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  from_time TIME NOT NULL,
  to_time TIME NOT NULL,
  kind VARCHAR(12) NOT NULL CHECK (kind IN ('unavailable','preferred')),
  valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_to DATE,
  note VARCHAR(200),
  CHECK (to_time > from_time)
);
CREATE INDEX idx_availability_emp ON employee_availability (employee_id);

-- Personnel documents (no health data). The file is stored AES-GCM encrypted in content_enc.
CREATE TABLE employee_document (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  doc_type VARCHAR(30) NOT NULL
    CHECK (doc_type IN ('contract','hygiene_instruction','work_permit','training_certificate','payslip','other')),
  title VARCHAR(200) NOT NULL,
  file_ref VARCHAR(255) NOT NULL DEFAULT 'db',
  file_name VARCHAR(255) NOT NULL,
  mime VARCHAR(100) NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_enc BYTEA NOT NULL,
  valid_until DATE,
  visible_to_employee BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_by_user_id INTEGER NOT NULL REFERENCES user_account(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_document_emp ON employee_document (employee_id);

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

CREATE TABLE management_question (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  subject VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered')),
  answer TEXT,
  answered_by_user_id INTEGER REFERENCES user_account(id),
  answered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE feed_post (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  author_user_id INTEGER NOT NULL REFERENCES user_account(id),
  author_name VARCHAR(120) NOT NULL,                    -- display name at posting time ("Maria G.")
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_feed_hotel ON feed_post (hotel_id, id DESC);
CREATE TABLE feed_comment (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES feed_post(id),
  author_user_id INTEGER NOT NULL REFERENCES user_account(id),
  author_name VARCHAR(120) NOT NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE TABLE feed_like (
  post_id INTEGER NOT NULL REFERENCES feed_post(id),
  user_id INTEGER NOT NULL REFERENCES user_account(id),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE calendar_feed (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  token_hash CHAR(64) NOT NULL UNIQUE,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
