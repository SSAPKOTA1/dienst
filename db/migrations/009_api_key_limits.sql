-- Public API keys get an expiry, scopes (what they may read) and an optional network allowlist.
ALTER TABLE api_key
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN scopes TEXT[] NOT NULL DEFAULT ARRAY['hotels:read','employees:read','schedule:read','attendance:read','absences:read'],
  ADD COLUMN allowed_cidrs TEXT[],                  -- NULL = any address
  ADD COLUMN last_used_ip VARCHAR(45);
-- keys that exist already expire a year after they were created
UPDATE api_key SET expires_at = created_at + INTERVAL '365 days' WHERE expires_at IS NULL;
ALTER TABLE api_key ALTER COLUMN expires_at SET NOT NULL;
