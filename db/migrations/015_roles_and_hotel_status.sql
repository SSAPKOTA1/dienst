-- Hotels can be switched off (history stays); admins can be limited to single hotels; staff roles can be revoked.

-- A deactivated hotel disappears from planning, the tablet and every scope; its records stay.
ALTER TABLE hotel ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE hotel ADD COLUMN deactivated_at TIMESTAMPTZ;

-- Hotel level access for admins, next to admin_company (whole company).
CREATE TABLE admin_hotel (
  admin_id INTEGER NOT NULL REFERENCES admin(admin_id),
  hotel_id INTEGER NOT NULL REFERENCES hotel(id),
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  assigned_by_id INTEGER NOT NULL REFERENCES super_admin(super_admin_id),
  PRIMARY KEY (admin_id, hotel_id)
);

-- A revoked staff role keeps its row (other records point at it) but grants nothing.
ALTER TABLE super_admin ADD COLUMN revoked_at TIMESTAMPTZ;
ALTER TABLE admin ADD COLUMN revoked_at TIMESTAMPTZ;
ALTER TABLE manager ADD COLUMN revoked_at TIMESTAMPTZ;
