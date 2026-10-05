#!/usr/bin/env bash
# Backs up the database with pg_dump (custom format, compressed), writes a SHA-256 checksum, optionally encrypts
# the file with age, and deletes backups older than BACKUP_KEEP_DAYS.
#
#   DATABASE_URL           connection string (required)
#   BACKUP_DIR             target directory (default ./backups)
#   BACKUP_KEEP_DAYS       how long to keep files (default 14)
#   BACKUP_AGE_RECIPIENT   age public key; when set the dump is encrypted and the plain file removed
#   BACKUP_METRICS_FILE    optional node_exporter textfile that receives the time of the last good backup
#
# Example (cron, every night):  0 2 * * *  DATABASE_URL=... BACKUP_AGE_RECIPIENT=age1... /opt/dienst/scripts/ops/backup.sh
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$DIR/dienst-$STAMP.dump"
mkdir -p "$DIR"
umask 077

pg_dump --format=custom --compress=6 --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$FILE.partial"
mv "$FILE.partial" "$FILE"

if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$FILE.age" "$FILE"
  rm -f "$FILE"
  FILE="$FILE.age"
fi
( cd "$DIR" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256" )

# rotate: only files this script writes
find "$DIR" -maxdepth 1 -type f \( -name 'dienst-*.dump' -o -name 'dienst-*.dump.age' -o -name 'dienst-*.sha256' \) -mtime +"$KEEP" -delete

echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
# for the DienstBackupTooOld alert (deploy/alerts.yml): a node_exporter textfile with the time of the last good backup
if [[ -n "${BACKUP_METRICS_FILE:-}" ]]; then
  echo "dienst_backup_last_success_timestamp_seconds $(date +%s)" > "$BACKUP_METRICS_FILE.tmp" && mv "$BACKUP_METRICS_FILE.tmp" "$BACKUP_METRICS_FILE"
fi
