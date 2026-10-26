#!/usr/bin/env bash
# One-time: encrypted off-site copy of /mnt/data/backups on Google Drive (free 15 GB), via rclone.
# Files are encrypted on the Pi before upload (rclone crypt): Google only sees scrambled names and bytes.
#
#   ./offsite-setup.sh
#
# Steps it walks you through:
#   1. installs rclone
#   2. `rclone config` to add a Google Drive remote named "gdrive". The Pi has no browser:
#      answer "n" to "Use web browser to automatically authenticate?", then run the
#      `rclone authorize "drive" ...` line it prints on your laptop (install rclone there:
#      rclone.org/downloads), sign in, and paste the token back into the Pi.
#   3. creates the encrypted remote "pibackup" (gdrive:pi-backups) with a NEW random passphrase,
#      shown ONCE: save it in Bitwarden as "Pi off-site backup passphrase". Without it the
#      off-site copies cannot be decrypted.
#   4. installs the nightly upload (04:15, after the 03:30 backup) and runs it once.
set -euo pipefail
KIT_DIR="$(cd "$(dirname "$0")" && pwd)"

command -v rclone >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y rclone; }

if ! rclone listremotes | grep -qx 'gdrive:'; then
  echo "== Step 2: create a remote named exactly: gdrive  (type: drive, scope: 1 = full access is fine, or 3 = drive.file)"
  rclone config
  rclone listremotes | grep -qx 'gdrive:' || { echo "no remote called gdrive: was created; run again" >&2; exit 1; }
fi

if ! rclone listremotes | grep -qx 'pibackup:'; then
  pw="$(openssl rand -base64 30 | tr -d '/+=' | cut -c1-32)"
  rclone config create pibackup crypt remote=gdrive:pi-backups \
    password="$(rclone obscure "$pw")" filename_encryption=standard directory_name_encryption=true >/dev/null
  echo
  echo "================ SAVE THIS IN BITWARDEN NOW ================"
  echo "Name: Pi off-site backup passphrase"
  echo "Passphrase: $pw"
  echo "(rclone remote pibackup = crypt over gdrive:pi-backups)"
  echo "============================================================"
  unset pw
  read -rp "Press Enter once it is saved... " _
  clear || true
fi

BIN="$HOME/supabase-project/offsite-sync.sh"
cp "$KIT_DIR/offsite-sync.sh" "$BIN"; chmod 755 "$BIN"
LINE="15 4 * * * $BIN >> $HOME/supabase-project/offsite.log 2>&1"
( crontab -l 2>/dev/null | grep -vF "$BIN" || true; echo "$LINE" ) | crontab -
echo "nightly off-site upload scheduled (04:15). First run now:"
"$BIN"
