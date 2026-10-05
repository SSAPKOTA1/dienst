-- M10 Leave (backlog): blackout periods, shift and leave wishes, vacation notices.
CREATE TABLE absence_blackout (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  department_id INTEGER REFERENCES department(id),
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  reason VARCHAR(200),
  max_concurrent_absent INTEGER CHECK (max_concurrent_absent IS NULL OR max_concurrent_absent >= 0), -- NULL = no vacation allowed
  created_by_user_id INTEGER NOT NULL REFERENCES user_account(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (to_date >= from_date)
);
CREATE INDEX idx_blackout_hotel ON absence_blackout (hotel_id, from_date, to_date);

CREATE TABLE employee_shift_wish (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  date DATE NOT NULL,
  shift_id INTEGER NOT NULL REFERENCES shift(id),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3),   -- 1 high, 2 medium, 3 low
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','granted','declined','withdrawn')),
  decided_by_user_id INTEGER REFERENCES user_account(id),
  decided_at TIMESTAMPTZ,
  decision_note VARCHAR(300),
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_shift_wish_emp ON employee_shift_wish (employee_id, date);

CREATE TABLE employee_leave_wish (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  leave_days DECIMAL(4,1) NOT NULL,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3),
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','granted','declined','withdrawn')),
  decided_by_user_id INTEGER REFERENCES user_account(id),
  decided_at TIMESTAMPTZ,
  decision_note VARCHAR(300),
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (end_date >= start_date)
);
CREATE INDEX idx_leave_wish_emp ON employee_leave_wish (employee_id, start_date);

-- Proof that the employer informed the employee about leave and expiry (BAG/EuGH duty)
CREATE TABLE vacation_notice (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  year INTEGER NOT NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('initial','reminder','final')),
  remaining_days DECIMAL(4,1) NOT NULL,
  channel VARCHAR(10) NOT NULL CHECK (channel IN ('email','in_app','print')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  UNIQUE (employee_id, year, kind)
);
