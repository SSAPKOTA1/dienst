-- Audit hash chains per company instead of one global chain.
-- The old chain needed one global lock for every audited write and could not be verified (the timestamp
-- it hashed was never stored). Version 2 rows are chained per `chain_key` (company id; rows without a
-- company use one of 16 sub-chains by actor, stored as a negative number) and hash only stored values, so
-- the chain can be recomputed. Rows written before this migration stay version 1 (not verifiable).
ALTER TABLE audit_log
  ADD COLUMN chain_key INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN prev_hash CHAR(64),
  ADD COLUMN hash_version SMALLINT NOT NULL DEFAULT 1;
CREATE INDEX idx_audit_chain ON audit_log (chain_key, id);
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id);
