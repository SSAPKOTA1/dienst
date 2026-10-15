-- Notification bar for admins and super admins: attendance alerts and new requests.
-- Alerts reuse the notification table. hotel_id lets the API filter an alert by the caller's current hotel scope.
ALTER TABLE notification ADD COLUMN hotel_id INTEGER REFERENCES hotel(id);
CREATE INDEX idx_notification_user_unread ON notification (user_id, id DESC) WHERE read_at IS NULL;

-- Thresholds per company (minutes after the planned shift start or end).
ALTER TABLE company
  ADD COLUMN alert_late_checkin_minutes SMALLINT NOT NULL DEFAULT 10
    CHECK (alert_late_checkin_minutes BETWEEN 1 AND 240),
  ADD COLUMN alert_missed_checkin_minutes SMALLINT NOT NULL DEFAULT 15
    CHECK (alert_missed_checkin_minutes BETWEEN 1 AND 240),
  -- below the 60 minutes after which the auto check-out closes the record, so the alert can still fire
  ADD COLUMN alert_missed_checkout_minutes SMALLINT NOT NULL DEFAULT 30
    CHECK (alert_missed_checkout_minutes BETWEEN 1 AND 59);
