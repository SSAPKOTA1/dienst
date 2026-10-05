-- version 2 rows keep their hashes but lose their chain columns; the chain cannot be verified after this
DROP INDEX IF EXISTS idx_audit_entity, idx_audit_chain;
ALTER TABLE audit_log DROP COLUMN IF EXISTS chain_key, DROP COLUMN IF EXISTS prev_hash, DROP COLUMN IF EXISTS hash_version;
