-- Recurring weekday preferences of an employee ("Mondays are good for me", "Sundays I would rather be off", with an
-- optional preferred shift). Like the date wishes they are never a promise: the planner sees them on the calendar and
-- decides. One row per employee and weekday (1 = Monday ... 7 = Sunday).
CREATE TABLE employee_weekday_pref (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employee(employee_id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  preference VARCHAR(10) NOT NULL CHECK (preference IN ('good', 'bad')),
  shift_id INTEGER REFERENCES shift(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, weekday)
);
