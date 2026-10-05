-- Security keys and passkeys (WebAuthn) as a second factor for staff accounts.
CREATE TABLE webauthn_credential (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,            -- base64url, as the authenticator reports it
  public_key BYTEA NOT NULL,                     -- COSE public key
  counter BIGINT NOT NULL DEFAULT 0,             -- signature counter (clone detection)
  transports TEXT[],
  name VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX idx_webauthn_user ON webauthn_credential (user_id);
