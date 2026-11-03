#!/usr/bin/env bash
# One-time: encrypted off-site backups in a PRIVATE GitHub repo (free, no card, no API).
#
#   ./offsite-github-setup.sh kushagra486/pi-backups
#
# Before running: create an EMPTY private repo on github.com (New repository > Private,
# no README). The script then:
#   1. creates an encryption key (age). Its secret half is shown ONCE: save it in Bitwarden as
#      "Pi backup decryption key". Without it nobody (you included) can read the backups.
#   2. creates an SSH deploy key that can reach ONLY this repo, and shows its public half:
#      repo > Settings > Deploy keys > Add deploy key > paste > tick "Allow write access".
#   3. installs the nightly upload (04:15, after the 03:30 backup) and runs it once.
set -euo pipefail
REPO="${1:?usage: offsite-github-setup.sh OWNER/REPO   (an empty PRIVATE repo)}"
KIT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF_DIR="$HOME/.config/pi-backup"
KEY="$CONF_DIR/age.key"
DEPLOY="$HOME/.ssh/pi_backups_deploy"
mkdir -p "$CONF_DIR" "$HOME/.ssh"; chmod 700 "$CONF_DIR" "$HOME/.ssh"

command -v age >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y age; }
command -v git >/dev/null || sudo apt-get install -y git

if [ ! -f "$KEY" ]; then
  (umask 077; age-keygen -o "$KEY" 2>/dev/null)
  echo
  echo "=========== SAVE THIS IN BITWARDEN NOW (secure note) ==========="
  echo "Name: Pi backup decryption key"
  cat "$KEY"
  echo "================================================================"
  read -rp "Press Enter once it is saved... " _
  clear || true
fi

if [ ! -f "$DEPLOY" ]; then
  ssh-keygen -q -t ed25519 -N '' -C "pi-backups-deploy@$(hostname)" -f "$DEPLOY"
fi
echo
echo "Add this as a DEPLOY KEY on https://github.com/$REPO/settings/keys (tick 'Allow write access'):"
echo
cat "$DEPLOY.pub"
echo
read -rp "Press Enter once it is added... " _

umask 077
{ echo "REPO=$REPO"; echo "RECIPIENT=$(age-keygen -y "$KEY")"; } > "$CONF_DIR/config"

GIT_SSH_COMMAND="ssh -i $DEPLOY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
  git ls-remote "git@github.com:$REPO.git" >/dev/null \
  || { echo "cannot reach the repo with the deploy key: is the key added with write access?" >&2; exit 1; }

BIN="$HOME/supabase-project/offsite-github-sync.sh"
cp "$KIT_DIR/offsite-github-sync.sh" "$BIN"; chmod 755 "$BIN"
LINE="15 4 * * * $BIN >> $HOME/supabase-project/offsite.log 2>&1"
( crontab -l 2>/dev/null | grep -vF "offsite" || true; echo "$LINE" ) | crontab -
echo "nightly encrypted upload scheduled (04:15). First run now:"
"$BIN"
