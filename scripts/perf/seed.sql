-- Synthetic data for index profiling: 3 companies, 30 hotels, 3000 employees, ~1 year of history.
-- Usage: createdb dienst_perf; DATABASE_URL=.../dienst_perf pnpm db:migrate; psql dienst_perf -f scripts/perf/seed.sql
\timing off
WITH u AS (INSERT INTO user_account (email, status) VALUES ('perf-sa@x.test', 'active') RETURNING id)
  INSERT INTO super_admin (user_id, first_name, last_name) SELECT id, 'S', 'A' FROM u;
INSERT INTO company (name, created_by_id) SELECT 'Perf ' || g, 1 FROM generate_series(1, 3) g;
INSERT INTO hotel (company_id, name, city, federal_state)
  SELECT 1 + (g % 3), 'Hotel ' || g, 'City', 'HE' FROM generate_series(1, 30) g;
INSERT INTO department (hotel_id, name) SELECT h.id, d FROM hotel h, unnest(ARRAY['Rezeption','Housekeeping','Frühstück']) d;
INSERT INTO shift (hotel_id, department_id, name, start_time, end_time, break_duration_minutes)
  SELECT d.hotel_id, d.id, 'Früh', '06:00', '14:00', 30 FROM department d;
-- 3000 users and employees (100 per hotel)
INSERT INTO user_account (email, status) SELECT 'e' || g || '@perf.test', 'active' FROM generate_series(1, 3000) g;
INSERT INTO employee (user_id, company_id, primary_hotel_id, primary_department_id, personnel_number, first_name, last_name, date_of_birth, pin_hash, contract_start_date)
  SELECT u.id, h.company_id, h.id, (SELECT min(id) FROM department WHERE hotel_id = h.id), 'P' || u.id, 'First' || u.id, 'Last' || u.id, DATE '1990-01-01', 'x', DATE '2025-01-01'
  FROM user_account u JOIN hotel h ON h.id = 1 + ((u.id - 2) % 30)
  WHERE u.email LIKE 'e%@perf.test';
INSERT INTO employee_hotel (employee_id, hotel_id) SELECT employee_id, primary_hotel_id FROM employee;
-- schedule: one 06-14 shift per employee and day for 250 days (non overlapping)
INSERT INTO schedule (hotel_id, employee_id, shift_id, shift_date, planned_start, planned_end, planned_break_minutes, status, created_by_user_id, created_by_role)
  SELECT e.primary_hotel_id, e.employee_id, (SELECT min(id) FROM shift WHERE hotel_id = e.primary_hotel_id), d::date,
         (d::date + TIME '04:00') AT TIME ZONE 'UTC', (d::date + TIME '12:00') AT TIME ZONE 'UTC', 30, 'published', 1, 'admin'
  FROM employee e, generate_series(DATE '2026-01-01', DATE '2026-09-07', INTERVAL '1 day') d;
-- punch records for the same days
INSERT INTO punch_record (employee_id, hotel_id, schedule_id, shift_date, source, planned_start, planned_end, actual_punch_in, actual_punch_out,
                          paid_start, paid_end, actual_break_minutes, paid_hours, approval_status)
  SELECT s.employee_id, s.hotel_id, s.id, s.shift_date, 'kiosk', s.planned_start, s.planned_end, s.planned_start, s.planned_end,
         s.planned_start, s.planned_end, 30, 7.5, CASE WHEN s.shift_date > DATE '2026-08-20' AND s.id % 3 = 0 THEN 'pending' ELSE 'approved' END
  FROM schedule s;
INSERT INTO time_variation (punch_record_id, employee_id, hotel_id, variation_type, planned_time, actual_time, variation_minutes, status)
  SELECT id, employee_id, hotel_id, 'clock_in_late', planned_start, planned_start + INTERVAL '9 minutes', 9, CASE WHEN id % 5 = 0 THEN 'pending' ELSE 'approved' END
  FROM punch_record WHERE id % 4 = 0;
-- absences
INSERT INTO time_off (employee_id, start_date, end_date, time_off_days, type, status, counts_against_allowance, created_by_user_id)
  SELECT e.employee_id, DATE '2026-01-01' + ((e.employee_id * 7 + g * 20) % 330), DATE '2026-01-01' + ((e.employee_id * 7 + g * 20) % 330) + 2, 3, 'annual_leave',
         CASE WHEN g = 1 AND e.employee_id % 4 = 0 THEN 'pending' ELSE 'approved' END, TRUE, 1
  FROM employee e, generate_series(1, 6) g;
-- notifications and audit entries
INSERT INTO notification (user_id, kind, payload, read_at, created_at)
  SELECT e.user_id, 'schedule_published', '{}', CASE WHEN g % 10 = 0 THEN NULL ELSE NOW() END, NOW() - (g || ' hours')::interval
  FROM employee e, generate_series(1, 120) g;
INSERT INTO audit_log (company_id, hotel_id, actor_id, actor_type, action, entity_type, entity_id, status, chain_key, hash_version, created_at)
  SELECT h.company_id, h.id, 1, 'admin', 'schedule_updated', 'schedule', g, 'ok', h.company_id, 1, NOW() - (g || ' minutes')::interval
  FROM hotel h, generate_series(1, 6000) g;
INSERT INTO refresh_token (user_id, token_hash, active_role, expires_at, created_at)
  SELECT u.id, md5(u.id::text || g::text) || md5(g::text || u.id::text), 'employee', NOW() + INTERVAL '30 days', NOW() - (g || ' days')::interval FROM user_account u, generate_series(1, 6) g;
ANALYZE;
SELECT 'employees' t, count(*) FROM employee UNION ALL SELECT 'schedule', count(*) FROM schedule UNION ALL SELECT 'punch_record', count(*) FROM punch_record
UNION ALL SELECT 'time_off', count(*) FROM time_off UNION ALL SELECT 'notification', count(*) FROM notification UNION ALL SELECT 'audit_log', count(*) FROM audit_log;
