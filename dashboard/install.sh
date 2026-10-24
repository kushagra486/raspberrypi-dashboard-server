#!/usr/bin/env bash
# Install Pi Console on the Pi as a systemd service running as the current user.
#   cd ~/raspberrypi-dashboard-server/dashboard && ./install.sh
# Re-running is safe: it keeps config.json and the password.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_USER="$(id -un)"
RUN_HOME="$HOME"

log() { printf '===> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" != "0" ] || die "run as your normal user (it uses sudo where needed), not root"

log "installing system packages (tmux, build tools for node-pty)"
sudo apt-get update -y
sudo apt-get install -y tmux build-essential python3
# Keep an existing Node.js (e.g. from NodeSource); Debian's npm package conflicts with it.
command -v node >/dev/null && command -v npm >/dev/null || sudo apt-get install -y nodejs npm

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js $NODE_MAJOR is too old; need 18 or newer"

log "installing dependencies"
cd "$DIR"
npm ci --omit=dev --no-audit --no-fund

[ -f config.json ] || { cp config.example.json config.json; log "created config.json (edit links and project folders there)"; }
mkdir -p "$RUN_HOME/projects"

if ! grep -q '^PI_CONSOLE_PASSWORD_HASH=' .env 2>/dev/null; then
  if [ "${GENERATE_PASSWORD:-0}" = "1" ]; then
    # Random password saved only on the Pi, readable only by this user.
    PW="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
    (umask 077; printf '%s\n' "$PW" > "$RUN_HOME/pi-console-password.txt")
    PI_CONSOLE_NEW_PASSWORD="$PW" node scripts/set-password.js
    log "generated a password: cat ~/pi-console-password.txt (then delete the file)"
  else
    log "choose the dashboard password"
    node scripts/set-password.js
  fi
fi

if ! id -nG "$RUN_USER" | grep -qw docker; then
  echo "NOTE: $RUN_USER is not in the docker group, so the Services tab cannot manage containers."
fi

log "installing systemd service pi-console"
sudo tee /etc/systemd/system/pi-console.service >/dev/null <<EOF
[Unit]
Description=Pi Console dashboard
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$DIR
Environment=HOME=$RUN_HOME
Environment=PATH=$RUN_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$(command -v node) server.js
Restart=on-failure
RestartSec=3
# Only stop the dashboard itself on restart; tmux (and the Claude sessions in it) keep running.
KillMode=process

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now pi-console
sudo systemctl restart pi-console
sleep 2
systemctl is-active --quiet pi-console || { sudo journalctl -u pi-console -n 30 --no-pager; die "service failed to start"; }

PORT="$(node -p 'require("./lib/config").load().port')"
IP="$(hostname -I | awk '{print $1}')"
log "Pi Console is running: http://$IP:$PORT  (or http://$(hostname).local:$PORT)"
echo "Logs: journalctl -u pi-console -f    Change password: npm run set-password && sudo systemctl restart pi-console"
