#!/usr/bin/env bash
# Smaller attack surface on the Pi, without changing anything that already works.
#
#   ./harden.sh check          what listens on which address (read-only)
#   ./harden.sh kong-8443      bind Kong's unused HTTPS port 8443 to 127.0.0.1 (was 0.0.0.0, LAN-visible)
#   ./harden.sh auto-updates   install unattended-upgrades (Debian security updates, nightly)
#
# Studio/API on :8000 and Pi Console on :7070 stay reachable on LAN + tailnet on purpose.
set -euo pipefail
PROJECT_DIR="${PROJECT_DIR:-$HOME/supabase-project}"
. "$(dirname "$0")/../supabase/lib-env.sh"

case "${1:-check}" in
  check)
    echo "== TCP listeners (0.0.0.0 / [::] = reachable from LAN and tailnet; 127.0.0.1 = Pi only)"
    sudo ss -tlnpH | awk '{print $4, $6}' | sed -E 's/users:\(\("([^"]+)".*/\1/' | sort -u
    echo
    echo "== Docker published ports"
    docker ps --format '{{.Names}}\t{{.Ports}}' | grep -v '^\S*\s*$' | sort
    echo
    echo "== swap (zram expected)"; swapon --show 2>/dev/null || true
    echo "== unattended-upgrades: $(systemctl is-enabled unattended-upgrades 2>/dev/null || echo not installed)"
    ;;
  kong-8443)
    cur="$(get_env KONG_HTTPS_PORT)"
    case "$cur" in 127.0.0.1:*) echo "already Pi-only: $cur"; exit 0;; esac
    # Only safe if the compose file publishes it as "${KONG_HTTPS_PORT}:8443"
    if ! (cd "$PROJECT_DIR" && docker compose config 2>/dev/null) | grep -q 'target: 8443'; then
      echo "Kong does not publish 8443 the expected way; not changing anything." >&2; exit 1
    fi
    env_backup
    set_env KONG_HTTPS_PORT "127.0.0.1:${cur:-8443}"
    if (cd "$PROJECT_DIR" && docker compose config) | grep -B2 -A3 'target: 8443' | grep -q 'host_ip: 127.0.0.1'; then
      svc="$( (cd "$PROJECT_DIR" && docker compose config --services) | grep -E '^(api-gw|kong)$' | head -1)"
      restart_services "$svc"
      sleep 5
      echo "Kong 8443 now Pi-only. API check on :8000 -> HTTP $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/rest/v1/)"
      echo "(401 = gateway up and asking for a key, which is correct)"
    else
      set_env KONG_HTTPS_PORT "${cur:-8443}"
      echo "compose did not accept the address form; reverted, nothing restarted." >&2; exit 1
    fi
    ;;
  auto-updates)
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y unattended-upgrades apt-listchanges
    printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' \
      | sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null
    sudo systemctl enable --now unattended-upgrades
    echo "security updates install nightly; no automatic reboots (Pi stays up)."
    sudo unattended-upgrade --dry-run 2>&1 | tail -3
    ;;
  *) sed -n 2,8p "$0"; exit 1 ;;
esac
