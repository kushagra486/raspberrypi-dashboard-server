#!/usr/bin/env bash
# Install the 5-minute health check with phone alerts.
#
#   ./install.sh
#
# 1. Install the free "ntfy" app (Android / iOS), tap +, subscribe to the topic this prints.
#    Anyone who knows the topic name can read the alerts, so it is random; alerts never
#    contain passwords or keys.
# 2. Optional, recommended: free account at healthchecks.io (no card), create a check with
#    period 5 min / grace 10 min, connect its "ntfy" or email integration, and paste its
#    ping URL when asked. That is what tells you when the whole Pi is offline.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$HOME/.config/pi-health.env"
mkdir -p "$HOME/.config"

if [ ! -f "$CONF" ]; then
  topic="pi-$(openssl rand -hex 10)"
  read -rp "healthchecks.io ping URL (Enter to skip): " hc
  umask 077
  { echo "NTFY_URL=https://ntfy.sh/$topic"; [ -n "$hc" ] && echo "HC_URL=$hc"; } > "$CONF"
  echo "ntfy topic to subscribe to in the app: $topic"
fi
chmod 600 "$CONF"

sudo install -m 755 "$DIR/pi-health.sh" /usr/local/bin/pi-health
sudo tee /etc/systemd/system/pi-health.service >/dev/null <<EOF
[Unit]
Description=Pi health check (alerts via ntfy)
After=network-online.target docker.service

[Service]
Type=oneshot
User=$USER
ExecStart=/usr/local/bin/pi-health
EOF
sudo tee /etc/systemd/system/pi-health.timer >/dev/null <<'EOF'
[Unit]
Description=Run the Pi health check every 5 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now pi-health.timer
/usr/local/bin/pi-health --print
. "$CONF"; curl -s -m 15 -H "Title: Pi alerts are on" -d "You will get a message here when something on the Pi needs attention." "$NTFY_URL" >/dev/null \
  && echo "test notification sent - check the ntfy app"
