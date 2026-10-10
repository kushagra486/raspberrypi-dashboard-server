#!/usr/bin/env bash
# Step 3: run backup.sh every night at 03:30 and once now to prove it works.
set -euo pipefail

KIT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/supabase-project/backup.sh"
cp "$KIT_DIR/backup.sh" "$BIN"
chmod 755 "$BIN"

"$BIN"

LINE="30 3 * * * $BIN >> $HOME/supabase-project/backup.log 2>&1"
( crontab -l 2>/dev/null | grep -vF "$BIN" || true; echo "$LINE" ) | crontab -
echo "nightly backup scheduled (03:30). Check with: crontab -l"
