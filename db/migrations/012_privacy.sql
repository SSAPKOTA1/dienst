-- Privacy: marks an employee whose personal data was anonymised (retention period over or erasure request).
ALTER TABLE employee ADD COLUMN anonymised_at TIMESTAMPTZ;
CREATE INDEX idx_employee_retention ON employee (company_id, contract_end_date)
  WHERE anonymised_at IS NULL AND contract_end_date IS NOT NULL;
-- reading personal data is logged as audit entries; this index serves the "who looked at my data" lists
CREATE INDEX idx_audit_entity_action ON audit_log (entity_type, entity_id, action, created_at DESC);
