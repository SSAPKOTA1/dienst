#!/usr/bin/env bash
# Tests the backup scripts against the database in DATABASE_URL (a seeded or migrated development/CI database).
# Needs pg_dump, pg_restore, psql, age and the built API (node scripts/build-api.mjs).
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
export MIGRATIONS_DIR="${MIGRATIONS_DIR:-$ROOT/db/migrations}"
W="$(mktemp -d)"; trap 'rm -rf "$W"; psql "${DATABASE_URL%/*}/postgres" -qc "drop database if exists dienst_bktest" >/dev/null 2>&1 || true' EXIT
ADMIN="${DATABASE_URL%/*}/postgres"
TEST="${DATABASE_URL%/*}/dienst_bktest"
fail() { echo "FAIL: $*" >&2; exit 1; }
expect_exit() { local want="$1"; shift; set +e; "$@" >/dev/null 2>&1; local got=$?; set -e; [[ "$got" == "$want" ]] || fail "expected exit $want, got $got: $*"; }

echo "1. backup writes a dump and a checksum"
BACKUP_DIR="$W" "$HERE/backup.sh" >/dev/null
DUMP="$(ls "$W"/dienst-*.dump)"; [[ -f "$DUMP.sha256" ]] || fail "no checksum"

echo "2. restore into an empty database works and the data is there"
psql "$ADMIN" -qc "create database dienst_bktest"
"$HERE/restore.sh" "$DUMP" "$TEST" >/dev/null
[[ "$(psql "$TEST" -Atc 'select count(*) from schema_migrations')" -gt 0 ]] || fail "no migrations in the restored database"

echo "3. restore refuses a database that is not empty"
expect_exit 4 "$HERE/restore.sh" "$DUMP" "$TEST"

echo "4. restore refuses a damaged file"
cp "$DUMP" "$W/damaged.dump"; cp "$DUMP.sha256" "$W/damaged.dump.sha256"
sed -i 's/dienst-[0-9TZ]*\.dump/damaged.dump/' "$W/damaged.dump.sha256"
printf 'x' >> "$W/damaged.dump"
psql "$ADMIN" -qc "drop database dienst_bktest" -c "create database dienst_bktest"
expect_exit 3 "$HERE/restore.sh" "$W/damaged.dump" "$TEST"

echo "5. an encrypted backup restores with the key and not without it"
age-keygen -o "$W/key.txt" 2>/dev/null
RECIPIENT="$(grep -o 'age1[a-z0-9]*' "$W/key.txt" | head -1)"
mkdir "$W/enc"; BACKUP_DIR="$W/enc" BACKUP_AGE_RECIPIENT="$RECIPIENT" "$HERE/backup.sh" >/dev/null
ENC="$(ls "$W"/enc/dienst-*.dump.age)"; [[ ! -e "${ENC%.age}" ]] || fail "plain dump left next to the encrypted one"
expect_exit 1 "$HERE/restore.sh" "$ENC" "$TEST"
BACKUP_AGE_IDENTITY="$W/key.txt" "$HERE/restore.sh" "$ENC" "$TEST" >/dev/null
[[ "$(psql "$TEST" -Atc 'select count(*) from employee')" == "$(psql "$DATABASE_URL" -Atc 'select count(*) from employee')" ]] || fail "employee counts differ"

echo "6. rotation deletes old backups only"
touch -d '30 days ago' "$W/dienst-20200101T000000Z.dump" "$W/dienst-20200101T000000Z.dump.sha256" "$W/unrelated.txt"
BACKUP_DIR="$W" BACKUP_KEEP_DAYS=14 "$HERE/backup.sh" >/dev/null
[[ ! -e "$W/dienst-20200101T000000Z.dump" ]] || fail "old backup kept"
[[ -e "$W/unrelated.txt" ]] || fail "unrelated file deleted"

echo "7. the restore drill passes on a good backup"
BACKUP_DIR="$W" "$HERE/restore-drill.sh" >/dev/null

echo "8. the restore drill fails when the audit log was tampered with"
psql "$ADMIN" -qc "drop database if exists dienst_bktest" -c "create database dienst_bktest"
"$HERE/restore.sh" "$DUMP" "$TEST" >/dev/null
psql "$TEST" -qc "alter table audit_log disable trigger audit_log_no_update" -c "update audit_log set action = 'tampered' where id = (select min(id) from audit_log where hash_version = 2)"
mkdir "$W/bad"; BACKUP_DIR="$W/bad" DATABASE_URL="$TEST" "$HERE/backup.sh" >/dev/null
expect_exit 1 env BACKUP_DIR="$W/bad" "$HERE/restore-drill.sh"
echo "backup scripts: all checks passed"
