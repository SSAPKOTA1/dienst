DROP INDEX IF EXISTS idx_notification_user_created, idx_notification_unread, idx_time_off_employee_start, idx_time_off_pending,
  idx_punch_hotel_date, idx_punch_pending, idx_variation_pending, idx_variation_punch, idx_punch_history_record,
  idx_schedule_employee_date, idx_audit_company_created, idx_refresh_user_open, idx_employee_company_status,
  idx_employee_primary_hotel, idx_employee_hotel_by_hotel;
DROP INDEX IF EXISTS idx_audit_chain;
CREATE INDEX idx_audit_chain ON audit_log (chain_key, id);
