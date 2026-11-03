#!/usr/bin/env bash
# Nightly: encrypt the newest backups with age and push them to the private GitHub repo.
# Each run replaces the repo's single commit (force push of a fresh orphan commit), so the
# repo holds only the last KEEP dumps and never grows. Writes .offsite-ok for the health check.
set -euo pipefail
CONF_DIR="${CONF_DIR:-$HOME/.config/pi-backup}"
. "$CONF_DIR/config"                                   # REPO, RECIPIENT
BACKUP_DIR="${BACKUP_DIR:-/mnt/data/backups}"
KEEP="${KEEP:-14}"
WORK="${WORK:-$HOME/.cache/pi-backups-repo}"
REMOTE_URL="${REMOTE_URL:-git@github.com:$REPO.git}"
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i $HOME/.ssh/pi_backups_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new}"

mapfile -t dumps < <(ls -1t "$BACKUP_DIR"/db-*.dump 2>/dev/null | head -n "$KEEP")
[ ${#dumps[@]} -gt 0 ] || { echo "no dumps in $BACKUP_DIR, refusing to push an empty backup" >&2; exit 1; }
newest_env="$(ls -1t "$BACKUP_DIR"/env-* 2>/dev/null | head -1 || true)"

rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"
git init -q -b main
git config user.name "pi-backup"; git config user.email "pi-backup@$(hostname).local"

for f in "${dumps[@]}" ${newest_env:+"$newest_env"}; do
  age -r "$RECIPIENT" -o "$(basename "$f").age" "$f"
done
# isolated projects: same treatment, one folder each
for dir in "$BACKUP_DIR"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  mapfile -t pd < <(ls -1t "$dir"db-*.dump 2>/dev/null | head -n "$KEEP")
  [ ${#pd[@]} -gt 0 ] || continue
  mkdir -p "$name"
  penv="$(ls -1t "$dir"env-* 2>/dev/null | head -1 || true)"
  for f in "${pd[@]}" ${penv:+"$penv"}; do age -r "$RECIPIENT" -o "$name/$(basename "$f").age" "$f"; done
done
cat > README.md <<'EOF'
# Pi database backups (encrypted)

Nightly `pg_dump -Fc` of the Raspberry Pi's Supabase Postgres, plus the newest `.env`,
encrypted with [age](https://age-encryption.org). Only the newest dumps are kept.

Restore (needs the "Pi backup decryption key" from Bitwarden saved as key.txt):

    age -d -i key.txt db-YYYYMMDD-HHMMSS.dump.age > db.dump
    pg_restore --list db.dump      # check it
    # full restore into a fresh Supabase: see supabase/README.md in raspberrypi-dashboard-server
EOF
git add -A
git commit -qm "backups $(date -Is) (${#dumps[@]} dumps)"
git push -q --force "$REMOTE_URL" main
date -Is > "$BACKUP_DIR/.offsite-ok"
echo "offsite ok $(date -Is): ${#dumps[@]} encrypted dumps -> $REPO ($(du -sh --exclude=.git . | cut -f1))"
