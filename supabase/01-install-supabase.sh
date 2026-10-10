#!/usr/bin/env bash
# Step 2: install the official self-hosted Supabase stack in ~/supabase-project
# and apply the Pi 5 overrides.
#
# Usage:   ./01-install-supabase.sh                      # uses the Pi's LAN IP
#          PUBLIC_URL=https://db.example.com ./01-install-supabase.sh
#
# Run as your normal user (not root). Re-running is safe: it will not overwrite
# an existing project's secrets.
set -euo pipefail

KIT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$HOME/supabase-project}"
SETUP_URL="https://raw.githubusercontent.com/supabase/supabase/master/docker/setup.sh"

log() { printf '===> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" != "0" ] || die "run as your normal user, not root"
command -v docker >/dev/null || die "Docker is missing - run sudo ./00-prepare-pi.sh first"
docker info >/dev/null 2>&1 || die "cannot talk to Docker - log out/in after step 1, or run: newgrp docker"
mountpoint -q /mnt/data || die "/mnt/data is not mounted - run sudo ./00-prepare-pi.sh /dev/sdX1 first"

LAN_IP="$(hostname -I | awk '{print $1}')"
PUBLIC_URL="${PUBLIC_URL:-http://$LAN_IP:8000}"

if [ -f "$PROJECT_DIR/docker-compose.yml" ]; then
  log "$PROJECT_DIR already exists - skipping the official bootstrap"
else
  log "downloading the official Supabase setup script (read it first if you like: $SETUP_URL)"
  TMP="$(mktemp -d)"
  curl -fsSL "$SETUP_URL" -o "$TMP/setup.sh"
  mkdir -p "$(dirname "$PROJECT_DIR")"
  ( cd "$(dirname "$PROJECT_DIR")" && sh "$TMP/setup.sh" -y --skip-deps --project-dir "$(basename "$PROJECT_DIR")" )
  rm -rf "$TMP"
fi

cd "$PROJECT_DIR"
[ -f .env ] || die ".env was not created - check the output above"

set_env() {  # set_env KEY VALUE  (edits or appends in .env)
  local key="$1" val="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}

log "pointing URLs at $PUBLIC_URL"
set_env SUPABASE_PUBLIC_URL "$PUBLIC_URL"
set_env API_EXTERNAL_URL "$PUBLIC_URL/auth/v1"

# stronger dashboard password if the default is still there
if grep -q '^DASHBOARD_PASSWORD=this_password_is_insecure' .env; then
  NEWPW="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  set_env DASHBOARD_PASSWORD "$NEWPW"
  log "generated a dashboard password (shown at the end)"
fi

log "installing Pi overrides"
cp "$KIT_DIR/docker-compose.pi.yml" ./docker-compose.pi.yml
if ! grep -q 'docker-compose.pi.yml' .env; then
  sh run.sh config add pi
fi

log "validating the combined compose file"
docker compose config -q || die "compose validation failed - see the error above"

log "starting Supabase (first start pulls ~2 GB of images; this takes a while)"
sh run.sh pull
sh run.sh start

chmod 600 .env
echo
log "Supabase is up."
echo
echo "  Dashboard + API : $PUBLIC_URL"
echo "  Dashboard login : $(grep '^DASHBOARD_USERNAME=' .env | cut -d= -f2-) / $(grep '^DASHBOARD_PASSWORD=' .env | cut -d= -f2-)"
echo "  Keys + passwords: cd $PROJECT_DIR && sh run.sh secrets"
echo
echo "Back up $PROJECT_DIR/.env somewhere safe (not only on this Pi) - without"
echo "its JWT keys the database and your apps' tokens cannot be recovered."
echo "Next: ./02-install-backups.sh"
