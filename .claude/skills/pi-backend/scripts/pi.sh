#!/usr/bin/env bash
# Everyday operations on the Pi backend. Run after `source connect.sh`.
#
#   pi.sh status                 health of Supabase, Pi Console, memory, disks, backups
#   pi.sh sql "select 1"         run SQL as supabase_admin (or: pi.sh sql < file.sql)
#   pi.sh new-app NAME           create an app schema exposed through the API
#   pi.sh app-config NAME        what an app needs: API URL, publishable key, schema
#   pi.sh backups                list database backups
#   pi.sh backup-now             run a backup immediately
#   pi.sh logs SERVICE [N]       last N log lines of a Supabase container (default 100)
#
# Secret values (secret key, DB password, dashboard password) are never printed.
set -euo pipefail

PROJECT='~/supabase-project'
API_URL="${PI_API_URL:-https://raspberrypi.tailc40262.ts.net}"
cmd="${1:-status}"; shift || true

case "$cmd" in
  status)
    ssh pi 'echo "== Pi: $(hostname), up $(uptime -p)"; free -h | sed -n 2p
            vcgencmd get_throttled 2>/dev/null | sed "s/^/power: /"
            df -h / /mnt/data | tail -2
            echo "== Supabase"; docker ps --format "{{.Names}}\t{{.Status}}" | sort
            echo "== Pi Console: $(systemctl is-active pi-console)"
            echo "== Funnel"; sudo tailscale funnel status 2>/dev/null | grep -E "^https|\|--" || echo "funnel off"
            echo "== Latest backup"; ls -1t /mnt/data/backups/db-*.dump 2>/dev/null | head -1 | xargs -r ls -lh'
    ;;
  sql)
    if [ $# -gt 0 ]; then
      printf '%s\n' "$*" | ssh pi 'docker exec -i supabase-db psql -h localhost -U supabase_admin -d postgres -v ON_ERROR_STOP=1'
    else
      ssh pi 'docker exec -i supabase-db psql -h localhost -U supabase_admin -d postgres -v ON_ERROR_STOP=1'
    fi
    ;;
  new-app)
    name="${1:?usage: pi.sh new-app NAME}"
    ssh pi "cd ~/raspberrypi-dashboard-server/supabase && ./new-project.sh '$name'"
    ;;
  app-config)
    name="${1:-public}"
    key="$(ssh pi "grep -E '^(SUPABASE_PUBLISHABLE_KEY|ANON_KEY)=' $PROJECT/.env | head -1 | cut -d= -f2-")"
    cat <<EOF
SUPABASE_URL=$API_URL
SUPABASE_PUBLISHABLE_KEY=$key
SUPABASE_SCHEMA=$name

// createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY, { db: { schema: '$name' } })
// The publishable key is meant for browsers; RLS must be on for every table in '$name'.
// Server-only code that needs the secret key: read it on the Pi (sh run.sh secrets), never commit it.
EOF
    ;;
  backups)
    ssh pi 'ls -lht /mnt/data/backups | head -20; echo; crontab -l | grep backup'
    ;;
  backup-now)
    ssh pi '~/supabase-project/backup.sh'
    ;;
  logs)
    svc="${1:?usage: pi.sh logs SERVICE [N]}"; n="${2:-100}"
    ssh pi "docker logs --tail '$n' '$svc' 2>&1"
    ;;
  *)
    sed -n 2,12p "$0"; exit 1 ;;
esac
