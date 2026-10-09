#!/usr/bin/env bash
# Nightly backup: Postgres dump + the .env secrets file -> /mnt/data/backups
# Storage files already live on the pendrive. Keeps the newest 14 backups.
# The database is on the SD card and the backup on the pendrive, so one dying
# card does not take both. Copy /mnt/data/backups off the Pi now and then too.
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-$HOME/supabase-project}"
BACKUP_DIR="${BACKUP_DIR:-/mnt/data/backups}"
KEEP="${KEEP:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mountpoint -q /mnt/data || { echo "ERROR: /mnt/data not mounted - refusing to write backups to the SD card" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
umask 077

# custom-format dump of the main database (restorable with pg_restore)
TMP="$BACKUP_DIR/db-$STAMP.dump.tmp"
trap 'rm -f "$TMP"' EXIT   # don't leave partial dumps on the stick after a failure
docker exec supabase-db pg_dump -h localhost -U supabase_admin -d postgres -Fc > "$TMP"
mv "$TMP" "$BACKUP_DIR/db-$STAMP.dump"

# secrets (JWT keys etc.) - needed to restore a working project
cp "$PROJECT_DIR/.env" "$BACKUP_DIR/env-$STAMP"

# rotate
ls -1t "$BACKUP_DIR"/db-*.dump  2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --
ls -1t "$BACKUP_DIR"/env-*      2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --

echo "backup ok: $BACKUP_DIR/db-$STAMP.dump ($(du -h "$BACKUP_DIR/db-$STAMP.dump" | cut -f1))"
