ALTER TABLE shift DROP COLUMN IF EXISTS required_qualification_id;
ALTER TABLE employee DROP COLUMN IF EXISTS terminated_at, DROP COLUMN IF EXISTS termination_reason;
DROP TABLE IF EXISTS calendar_feed, feed_like, feed_comment, feed_post, management_question, announcement_ack, announcement,
  employee_document, employee_availability, employee_qualification, qualification, open_shift_claim, open_shift, shift_swap_request;
