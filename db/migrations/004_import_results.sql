-- Employee Excel import (SPEC 5.4): keep who ran it, the per-row result and the one-time credentials sheet.
ALTER TABLE import_job
  ADD COLUMN created_by_user_id INTEGER REFERENCES user_account(id),
  ADD COLUMN file_name VARCHAR(255),
  ADD COLUMN result JSONB,                       -- [{row, status: created|updated|skipped|error, field?, code?, message?}]
  ADD COLUMN raw_rows JSONB,                     -- original cell values per row, used by the error CSV
  ADD COLUMN credentials_enc BYTEA,              -- AES-GCM encrypted slips (PIN, activation code); wiped after the download or after 24 h
  ADD COLUMN credentials_expires_at TIMESTAMPTZ,
  ADD COLUMN credentials_downloaded_at TIMESTAMPTZ;
