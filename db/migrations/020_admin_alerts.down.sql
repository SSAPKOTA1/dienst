ALTER TABLE company
  DROP COLUMN IF EXISTS alert_late_checkin_minutes,
  DROP COLUMN IF EXISTS alert_missed_checkin_minutes,
  DROP COLUMN IF EXISTS alert_missed_checkout_minutes;
DROP INDEX IF EXISTS idx_notification_user_unread;
ALTER TABLE notification DROP COLUMN IF EXISTS hotel_id;
