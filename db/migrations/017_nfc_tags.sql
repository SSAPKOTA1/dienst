-- NFC tags a hotel mounts at the staff entrance. The tag only carries a random token; the server keeps its hash.
-- An employee proves presence at the hotel by tapping a tag with the Android app (instead of the network check of
-- the web punch). A revoked tag keeps its row so the audit trail still points at it.
CREATE TABLE hotel_nfc_tag (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  label VARCHAR(100) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  created_by_user_id INTEGER NOT NULL REFERENCES user_account(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX idx_hotel_nfc_tag_hotel ON hotel_nfc_tag(hotel_id);
