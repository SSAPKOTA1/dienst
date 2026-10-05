-- Indexes found by profiling the common read paths on synthetic data (scripts/perf: 3000 employees, 750k shifts and
-- punch records, 360k notifications). Partial indexes cover the "open work" queries (pending, unread, not revoked),
-- which touch a small share of the rows.
-- On a large live table create them with CREATE INDEX CONCURRENTLY outside this runner (see docs/PERFORMANCE.md).

-- home screen: latest notifications and the unread counter of one user
CREATE INDEX idx_notification_user_created ON notification (user_id, created_at DESC);
CREATE INDEX idx_notification_unread ON notification (user_id) WHERE read_at IS NULL;

-- absences: one employee over a period; the approval inbox only reads pending rows
CREATE INDEX idx_time_off_employee_start ON time_off (employee_id, start_date);
CREATE INDEX idx_time_off_pending ON time_off (employee_id) WHERE status = 'pending';

-- worked time: reports and exports per hotel and period; the approval inbox per hotel
CREATE INDEX idx_punch_hotel_date ON punch_record (hotel_id, shift_date);
CREATE INDEX idx_punch_pending ON punch_record (hotel_id, shift_date DESC, id DESC)
  WHERE approval_status = 'pending' AND actual_punch_out IS NOT NULL;
CREATE INDEX idx_variation_pending ON time_variation (hotel_id) WHERE status = 'pending';
CREATE INDEX idx_variation_punch ON time_variation (punch_record_id);
CREATE INDEX idx_punch_history_record ON punch_record_history (punch_record_id);

-- schedule of one employee (the exclusion constraint's index is partial and built for overlap checks)
CREATE INDEX idx_schedule_employee_date ON schedule (employee_id, shift_date);

-- audit: newest entries of a company, the chain head lookup of every audited write (only version 2 rows)
CREATE INDEX idx_audit_company_created ON audit_log (company_id, created_at DESC);
DROP INDEX idx_audit_chain;
CREATE INDEX idx_audit_chain ON audit_log (chain_key, id) WHERE hash_version = 2;

-- sessions, employee lists
CREATE INDEX idx_refresh_user_open ON refresh_token (user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_employee_company_status ON employee (company_id, status);
CREATE INDEX idx_employee_primary_hotel ON employee (primary_hotel_id, status);
CREATE INDEX idx_employee_hotel_by_hotel ON employee_hotel (hotel_id, employee_id);
