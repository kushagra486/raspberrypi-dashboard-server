#!/usr/bin/env bash
# Nightly: upload new backups to the encrypted rclone remote "pibackup:", keep 30 days there.
# Writes /mnt/data/backups/.offsite-ok (timestamp) on success; the health check watches it.
set -euo pipefail
BACKUP_DIR="${BACKUP_DIR:-/mnt/data/backups}"
REMOTE="${REMOTE:-pibackup:}"
KEEP_DAYS="${KEEP_DAYS:-30}"

rclone copy "$BACKUP_DIR" "$REMOTE" --include 'db-*.dump' --include 'env-*' --max-age 72h --transfers 2 --retries 3
rclone delete "$REMOTE" --min-age "${KEEP_DAYS}d" || true
date -Is > "$BACKUP_DIR/.offsite-ok"
echo "offsite ok $(date -Is): $(rclone size "$REMOTE" --json | tr -d '\n')"
