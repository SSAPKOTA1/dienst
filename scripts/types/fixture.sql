-- Extra demo rows so that every list endpoint has an example for the type generator.
-- Run on a freshly seeded demo database only (scripts/types/gen.mjs does this).
WITH maria AS (SELECT employee_id, user_id FROM employee WHERE personnel_number = 'P100' LIMIT 1),
     mgr AS (SELECT user_id FROM manager LIMIT 1),
     sh AS (SELECT id, department_id FROM shift WHERE hotel_id = 1 ORDER BY id LIMIT 1)
INSERT INTO feed_post (hotel_id, author_user_id, author_name, body)
  SELECT 1, mgr.user_id, 'Anna K.', 'Willkommen im Team-Feed' FROM mgr;
INSERT INTO feed_comment (post_id, author_user_id, author_name, body)
  SELECT p.id, p.author_user_id, 'Anna K.', 'Danke!' FROM feed_post p LIMIT 1;
INSERT INTO announcement (company_id, title, body, pinned, requires_ack, created_by_user_id)
  SELECT 1, 'Betriebsversammlung', 'Am Freitag um 14 Uhr', true, true, user_id FROM manager LIMIT 1;
INSERT INTO announcement (company_id, title, body, created_by_user_id)
  SELECT 1, 'Parkplatz', 'Bitte Parkkarte nutzen', user_id FROM manager LIMIT 1;
INSERT INTO management_question (employee_id, hotel_id, subject, body)
  SELECT employee_id, 1, 'Dienstkleidung', 'Wann gibt es neue Hemden?' FROM employee WHERE personnel_number = 'P100';
UPDATE management_question SET status = 'answered', answer = 'Im November.', answered_at = now() WHERE false;
INSERT INTO management_question (employee_id, hotel_id, subject, body, status, answer, answered_at)
  SELECT employee_id, 1, 'Urlaub Weihnachten', 'Geht der 24.?', 'answered', 'Ja.', now() FROM employee WHERE personnel_number = 'P100';
INSERT INTO employee_availability (employee_id, weekday, from_time, to_time, kind, note)
  SELECT employee_id, 2, '08:00', '12:00', 'unavailable', 'Sprachkurs' FROM employee WHERE personnel_number = 'P100';
INSERT INTO employee_availability (employee_id, weekday, from_time, to_time, kind, valid_to)
  SELECT employee_id, 5, '14:00', '22:00', 'preferred', CURRENT_DATE + 60 FROM employee WHERE personnel_number = 'P100';
INSERT INTO employee_leave_wish (employee_id, hotel_id, start_date, end_date, leave_days, priority, reason)
  SELECT employee_id, 1, CURRENT_DATE + 90, CURRENT_DATE + 97, 5, 1, 'Familienfeier' FROM employee WHERE personnel_number = 'P100';
INSERT INTO employee_leave_wish (employee_id, hotel_id, start_date, end_date, leave_days, priority, status, decision_note)
  SELECT employee_id, 1, CURRENT_DATE + 120, CURRENT_DATE + 124, 3, 2, 'declined', 'Blockzeit' FROM employee WHERE personnel_number = 'P100';
INSERT INTO employee_shift_wish (employee_id, hotel_id, date, shift_id, priority, reason)
  SELECT e.employee_id, 1, CURRENT_DATE + 10, (SELECT id FROM shift WHERE hotel_id = 1 ORDER BY id LIMIT 1), 1, 'Früh bitte'
  FROM employee e WHERE personnel_number = 'P100';
INSERT INTO employee_shift_wish (employee_id, hotel_id, date, shift_id, priority, status, decision_note)
  SELECT e.employee_id, 1, CURRENT_DATE + 11, (SELECT id FROM shift WHERE hotel_id = 1 ORDER BY id LIMIT 1), 2, 'declined', 'Unterbesetzt'
  FROM employee e WHERE personnel_number = 'P100';
INSERT INTO open_shift (hotel_id, department_id, shift_date, planned_start, planned_end, planned_break_minutes, created_by_user_id, created_by_role, shift_id)
  SELECT 1, department_id, CURRENT_DATE + 3, (CURRENT_DATE + 3) + time '06:00', (CURRENT_DATE + 3) + time '14:00', 30, (SELECT user_id FROM manager LIMIT 1), 'manager', id
  FROM shift WHERE hotel_id = 1 ORDER BY id LIMIT 1;
INSERT INTO open_shift_claim (open_shift_id, employee_id)
  SELECT (SELECT id FROM open_shift LIMIT 1), employee_id FROM employee WHERE personnel_number = 'P101';
INSERT INTO shift_swap_request (hotel_id, schedule_id, requester_employee_id, counterpart_employee_id, status, reason, expires_at)
  SELECT 1, s.id, s.employee_id, (SELECT employee_id FROM employee WHERE personnel_number = 'P101'), 'accepted_by_peer', 'Arzttermin', now() + interval '2 days'
  FROM schedule s JOIN employee e ON e.employee_id = s.employee_id
  WHERE e.personnel_number = 'P100' AND s.status = 'published' AND s.planned_start > now() ORDER BY s.planned_start LIMIT 1;
INSERT INTO vacation_notice (employee_id, year, kind, remaining_days, channel)
  SELECT employee_id, EXTRACT(year FROM CURRENT_DATE)::int, 'reminder', 12.5, 'in_app' FROM employee WHERE personnel_number = 'P100';
INSERT INTO employee_document (employee_id, doc_type, title, file_name, mime, size_bytes, content_enc, uploaded_by_user_id, valid_until)
  SELECT employee_id, 'hygiene_instruction', 'Hygieneschulung', 'hygiene.pdf', 'application/pdf', 4, '\x00010203', (SELECT user_id FROM admin LIMIT 1), CURRENT_DATE + 200
  FROM employee WHERE personnel_number = 'P100';
INSERT INTO employee_qualification (employee_id, qualification_id, valid_until)
  SELECT e.employee_id, q.id, CURRENT_DATE + 100 FROM employee e, qualification q WHERE e.personnel_number = 'P100' LIMIT 1;
INSERT INTO occupancy_forecast (hotel_id, on_date, occupancy_pct) VALUES (1, CURRENT_DATE + 1, 85);
INSERT INTO staffing_rule (hotel_id, shift_id, min_occupancy_pct, headcount)
  SELECT 1, id, 70, 3 FROM shift WHERE hotel_id = 1 ORDER BY id LIMIT 1;
