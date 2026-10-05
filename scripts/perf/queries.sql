-- name: notifications of one user, newest first
select * from notification where user_id = 1500 order by created_at desc limit 20;
-- name: unread notification count
select count(*) from notification where user_id = 1500 and read_at is null;
-- name: absences of one employee in a year
select * from time_off where employee_id = 1500 and start_date <= '2026-12-31' and end_date >= '2026-01-01' and status in ('approved','pending');
-- name: pending absences in the approval inbox (3 hotels)
select t.* from time_off t join employee_hotel eh on eh.employee_id = t.employee_id where eh.hotel_id in (3,6,9) and t.status = 'pending';
-- name: pending worked time in the approval inbox (2 hotels)
select * from punch_record where hotel_id in (3,6) and approval_status = 'pending' and actual_punch_out is not null order by shift_date desc, id desc limit 100;
-- name: worked time of a hotel for a month (reports, exports)
select * from punch_record where hotel_id = 3 and shift_date between '2026-08-01' and '2026-08-31';
-- name: schedule of one employee for a month (portal)
select * from schedule where employee_id = 1500 and shift_date between '2026-08-01' and '2026-08-31' and status <> 'cancelled';
-- name: pending variations of a hotel
select v.* from time_variation v where v.hotel_id = 3 and v.status = 'pending';
-- name: schedule grid of a hotel for a week (already indexed)
select * from schedule where hotel_id = 3 and shift_date between '2026-08-03' and '2026-08-09';
-- name: audit log of one entity
select * from audit_log where entity_type = 'schedule' and entity_id = 77 order by id desc limit 50;
-- name: audit log of a company, newest first (admin screen)
select * from audit_log where company_id = 2 order by created_at desc limit 50;
-- name: last entry of an audit chain (every audited write)
select entry_hash from audit_log where chain_key = 2 and hash_version = 2 order by id desc limit 1;
-- name: open refresh tokens of a user
select * from refresh_token where user_id = 1500 and revoked_at is null;
-- name: active employees of a company, by name
select * from employee where company_id = 1 and status = 'active' order by last_name, first_name limit 50;
-- name: employees of a hotel
select e.* from employee_hotel eh join employee e on e.employee_id = eh.employee_id where eh.hotel_id = 3 and e.status = 'active';
-- name: primary-hotel employees (planning grid rows)
select employee_id, display_name from employee where primary_hotel_id = 3 and status = 'active';
-- name: worked time of one employee for a month (indexed)
select * from punch_record where employee_id = 1500 and shift_date between '2026-08-01' and '2026-08-31';
