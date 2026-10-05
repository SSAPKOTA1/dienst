-- The kiosk roster and the live view look up the punch records of a list of schedule entries; without this index
-- that was a scan of the whole punch table (52 ms with 750,000 rows, on every roster poll of every tablet).
CREATE INDEX idx_punch_schedule ON punch_record (schedule_id) WHERE schedule_id IS NOT NULL;
