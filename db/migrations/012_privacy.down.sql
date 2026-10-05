DROP INDEX IF EXISTS idx_audit_entity_action, idx_employee_retention;
ALTER TABLE employee DROP COLUMN IF EXISTS anonymised_at;
