#!/usr/bin/env bash
# Health check, run every 5 minutes by pi-health.timer. Pushes to your phone via ntfy
# only when the set of problems CHANGES (new problem, or all clear), never every run.
# Optionally pings healthchecks.io, which alerts you when the Pi goes silent (offline,
# power cut) - the one thing the Pi cannot report about itself.
#
# Config: ~/.config/pi-health.env   NTFY_URL=https://ntfy.sh/<topic>   HC_URL=https://hc-ping.com/<uuid> (optional)
# Manual: pi-health.sh --print   (show checks, send nothing)
set -uo pipefail
CONF="${PI_HEALTH_CONF:-$HOME/.config/pi-health.env}"
[ -f "$CONF" ] && . "$CONF"
STATE="$HOME/.cache/pi-health.state"; mkdir -p "$(dirname "$STATE")"
BACKUP_DIR="${BACKUP_DIR:-/mnt/data/backups}"
problems=()
add() { problems+=("$1"); }

# disks
mountpoint -q /mnt/data || add "pendrive /mnt/data is NOT mounted (backups and storage files missing)"
for m in / /mnt/data; do
  use="$(df --output=pcent "$m" 2>/dev/null | tail -1 | tr -dc 0-9)"
  [ -n "$use" ] && [ "$use" -ge 85 ] && add "disk $m is ${use}% full"
done
# memory
avail_mb="$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)"
[ "$avail_mb" -lt 250 ] && add "low memory: ${avail_mb} MB available"
# power + heat: only CURRENT flags (bits 0-3); the since-boot flags stay set until reboot
if command -v vcgencmd >/dev/null; then
  t="$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)"
  [ -n "$t" ] && (( t & 0x1 )) && add "under-voltage right now (power supply too weak)"
  [ -n "$t" ] && (( t & 0x4 )) && add "CPU throttled right now"
  temp="$(vcgencmd measure_temp 2>/dev/null | tr -dc 0-9. | cut -d. -f1)"
  [ -n "$temp" ] && [ "$temp" -ge 80 ] && add "hot: ${temp}°C"
fi
# containers
while IFS=$'\t' read -r name status; do
  case "$status" in Up*unhealthy*|Restarting*|Exited*|Dead*|Created*) add "container $name: $status";; esac
done < <(docker ps -a --filter name=supabase --filter name=realtime --format '{{.Names}}\t{{.Status}}' 2>/dev/null)
docker info >/dev/null 2>&1 || add "Docker is not responding"
# services
for s in pi-console docker tailscaled; do
  systemctl is-active --quiet "$s" || add "service $s is not running"
done
# API answers (401 = gateway up, wants a key)
code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/rest/v1/ || true)"
case "$code" in 200|401) ;; *) add "Supabase API not answering (HTTP $code)";; esac
# backups
newest="$(ls -1t "$BACKUP_DIR"/db-*.dump 2>/dev/null | head -1)"
if [ -z "$newest" ]; then add "no database backup found"
elif [ $(( $(date +%s) - $(stat -c %Y "$newest") )) -gt $((26*3600)) ]; then add "last database backup is older than 26 h"; fi
if [ -f "$BACKUP_DIR/.offsite-ok" ] && [ $(( $(date +%s) - $(stat -c %Y "$BACKUP_DIR/.offsite-ok") )) -gt $((50*3600)) ]; then
  add "off-site backup upload has not succeeded for 2 days"
fi

if [ "${1:-}" = "--print" ]; then
  [ ${#problems[@]} -eq 0 ] && echo "all OK" || printf 'PROBLEM: %s\n' "${problems[@]}"; exit 0
fi

now="$(printf '%s\n' "${problems[@]}" | sort)"
before="$(cat "$STATE" 2>/dev/null || true)"
if [ "$now" != "$before" ] && [ -n "${NTFY_URL:-}" ]; then
  if [ -z "$now" ]; then
    curl -s -m 15 -H "Title: Pi: all clear" -H "Tags: white_check_mark" -d "Everything is healthy again." "$NTFY_URL" >/dev/null || true
  else
    curl -s -m 15 -H "Title: Pi needs attention" -H "Priority: high" -H "Tags: warning" -d "$now" "$NTFY_URL" >/dev/null || true
  fi
fi
printf '%s' "$now" > "$STATE"

if [ -n "${HC_URL:-}" ]; then
  if [ -z "$now" ]; then curl -s -m 10 -o /dev/null "$HC_URL" || true
  else curl -s -m 10 -o /dev/null --data-raw "$now" "$HC_URL/fail" || true; fi
fi
