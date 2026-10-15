-- Event calendar of a hotel (Messe, Tagung, Gruppe, ...): planners note special days so the plan can be staffed for
-- them. One row is one entry that may span several days (start_date to end_date, hotel-local dates, both inclusive).
CREATE TABLE hotel_event (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  title VARCHAR(120) NOT NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('messe', 'tagung', 'gruppe', 'event', 'other')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  note VARCHAR(2000),
  created_by_user_id INTEGER NOT NULL REFERENCES user_account(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);
CREATE INDEX idx_hotel_event_hotel_dates ON hotel_event(hotel_id, start_date, end_date);
