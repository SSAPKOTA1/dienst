#!/usr/bin/env bash
# Restores a backup into an EMPTY database.   restore.sh <backup file> <target DATABASE_URL>
# An encrypted file (.age) needs BACKUP_AGE_IDENTITY (path of the age private key). The checksum is verified first.
# After a restore start the API: it applies migrations that are newer than the backup (db:migrate).
set -euo pipefail
FILE="${1:?usage: restore.sh <backup file> <target database url>}"
TARGET="${2:?usage: restore.sh <backup file> <target database url>}"
[[ -f "$FILE" ]] || { echo "no such file: $FILE" >&2; exit 2; }

if [[ -f "$FILE.sha256" ]]; then
  ( cd "$(dirname "$FILE")" && sha256sum --check --quiet "$(basename "$FILE").sha256" ) || { echo "checksum mismatch: the backup is damaged" >&2; exit 3; }
else
  echo "warning: no checksum file next to the backup" >&2
fi

TABLES="$(psql "$TARGET" -Atc "select count(*) from information_schema.tables where table_schema = 'public'")"
if [[ "$TABLES" != "0" ]]; then
  echo "refusing to restore: the target database is not empty ($TABLES tables). Create a new empty database." >&2
  exit 4
fi

WORK="$FILE"
if [[ "$FILE" == *.age ]]; then
  : "${BACKUP_AGE_IDENTITY:?BACKUP_AGE_IDENTITY (age private key file) is required for an encrypted backup}"
  WORK="$(mktemp)"; trap 'rm -f "$WORK"' EXIT
  age --decrypt --identity "$BACKUP_AGE_IDENTITY" --output "$WORK" "$FILE"
fi
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$TARGET" "$WORK"
echo "restored $(basename "$FILE") into the target database"
