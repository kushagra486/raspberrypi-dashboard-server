#!/usr/bin/env bash
# Layer 4 (no-domain version): publish ONLY the Supabase API paths to the internet
# with Tailscale Funnel. Studio, Pi Console and SSH stay private to tailnet devices.
#
#   ./tailscale/setup-funnel.sh
#
# Prerequisites (one-time, by the owner): Pi logged in (`sudo tailscale up`),
# Funnel + HTTPS enabled for the tailnet in the Tailscale admin.
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-$HOME/supabase-project}"
PATHS="rest auth storage realtime functions graphql"

for p in $PATHS; do
  sudo tailscale funnel --bg --set-path="/$p/v1" "http://127.0.0.1:8000/$p/v1"
done

HOST="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
URL="https://$HOST"

cd "$PROJECT_DIR"
(umask 077; cp .env ".env.bak-$(date +%Y%m%d%H%M%S)")
sed -i "s|^SUPABASE_PUBLIC_URL=.*|SUPABASE_PUBLIC_URL=$URL|; s|^API_EXTERNAL_URL=.*|API_EXTERNAL_URL=$URL/auth/v1|" .env
docker compose up -d --wait

sudo tailscale funnel status
echo "Public Supabase API: $URL   (Studio stays at http://$(hostname):8000 on tailnet devices)"
