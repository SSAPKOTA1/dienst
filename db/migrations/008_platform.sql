-- M13 Platform: offline kiosk, occupancy staffing, public API keys, OIDC SSO.
-- Break start/stop, badge identification and web punch use columns that already exist in 001.

-- idempotency for punches queued offline on the tablet and synced later
CREATE TABLE offline_punch_log (
  id SERIAL PRIMARY KEY,
  kiosk_device_id INTEGER NOT NULL REFERENCES kiosk_device(id),
  client_id VARCHAR(64) NOT NULL,
  punch_record_id INTEGER REFERENCES punch_record(id),
  outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('applied','rejected')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kiosk_device_id, client_id)
);

-- occupancy forecast per hotel and day (imported by planners)
CREATE TABLE occupancy_forecast (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  on_date DATE NOT NULL,
  occupancy_pct INTEGER NOT NULL CHECK (occupancy_pct BETWEEN 0 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hotel_id, on_date)
);

-- "from X% occupancy this shift needs N people" - produces suggestions only
CREATE TABLE staffing_rule (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  shift_id INTEGER NOT NULL REFERENCES shift(id),
  min_occupancy_pct INTEGER NOT NULL CHECK (min_occupancy_pct BETWEEN 0 AND 100),
  headcount INTEGER NOT NULL CHECK (headcount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shift_id, min_occupancy_pct)
);

-- read-only public API keys; only the hash is stored, the key is shown once
CREATE TABLE api_key (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company(id),
  hotel_id INTEGER REFERENCES hotel(id),               -- NULL = whole company
  name VARCHAR(100) NOT NULL,
  key_prefix VARCHAR(12) NOT NULL,
  key_hash CHAR(64) NOT NULL UNIQUE,
  created_by_user_id INTEGER REFERENCES user_account(id),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- OIDC single sign-on per company; the client secret is stored encrypted
CREATE TABLE sso_provider (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL UNIQUE REFERENCES company(id),
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_enc BYTEA NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE sso_identity (
  id SERIAL PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES sso_provider(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES user_account(id),
  subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider_id, subject),
  UNIQUE (provider_id, user_id)
);

-- single-use marker for the short-lived ticket that carries a verified SSO login back to the web app
CREATE TABLE sso_ticket_use (
  jti VARCHAR(64) PRIMARY KEY,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
