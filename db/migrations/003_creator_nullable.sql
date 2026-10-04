-- Super admins have no `admin` row, so rows they create cannot reference admin(admin_id).
-- created_by_id becomes nullable (NULL = created by a super admin; the audit log has the actor).
ALTER TABLE employee ALTER COLUMN created_by_id DROP NOT NULL;
ALTER TABLE employee_contract ALTER COLUMN created_by_id DROP NOT NULL;
ALTER TABLE manager ALTER COLUMN created_by_id DROP NOT NULL;
ALTER TABLE import_job ALTER COLUMN admin_id DROP NOT NULL;
