#!/usr/bin/env bash
# Join a Claude cloud session to the tailnet and reach the Pi over Tailscale SSH.
#
#   source tailscale/claude-connect.sh      # then: ssh pi 'hostname'
#
# Needs TS_AUTHKEY in the environment: a reusable, ephemeral, pre-approved
# Tailscale auth key tagged tag:claude (see docs/claude-session-access.md).
# Runs tailscaled in userspace mode (no root network changes); the node is
# ephemeral, so it disappears from the tailnet shortly after the session ends.
set -euo pipefail

VERSION="${TS_VERSION:-1.104.2}"
BIN="${TS_BIN:-$HOME/.local/tailscale}"
STATE="${TS_STATE_DIR:-$HOME/.cache/tailscale}"
SOCK="$STATE/tailscaled.sock"

[ -n "${TS_AUTHKEY:-}" ] || { echo "TS_AUTHKEY is not set (environment settings -> variables)" >&2; return 1 2>/dev/null || exit 1; }

if [ ! -x "$BIN/tailscale" ]; then
  mkdir -p "$BIN"
  arch=amd64; [ "$(uname -m)" = aarch64 ] && arch=arm64
  curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${VERSION}_${arch}.tgz" \
    | tar -xz -C "$BIN" --strip-components=1 "tailscale_${VERSION}_${arch}/tailscale" "tailscale_${VERSION}_${arch}/tailscaled"
fi

mkdir -p "$STATE"
if ! "$BIN/tailscale" --socket="$SOCK" status >/dev/null 2>&1; then
  nohup "$BIN/tailscaled" --tun=userspace-networking --state=mem: \
    --statedir="$STATE" --socket="$SOCK" >"$STATE/tailscaled.log" 2>&1 &
  for _ in $(seq 1 20); do [ -S "$SOCK" ] && break; sleep 0.5; done
  "$BIN/tailscale" --socket="$SOCK" up --authkey="$TS_AUTHKEY" \
    --hostname="claude-$(hostname | tr -cd 'a-z0-9' | tail -c 8)" --accept-dns=false
fi

mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
if ! grep -q '^Host pi$' "$HOME/.ssh/config" 2>/dev/null; then
  cat >>"$HOME/.ssh/config" <<CFG
Host pi
  HostName raspberrypi
  User stdio
  ProxyCommand $BIN/tailscale --socket=$SOCK nc %h %p
  StrictHostKeyChecking accept-new
  ServerAliveInterval 30
CFG
  chmod 600 "$HOME/.ssh/config"
fi
"$BIN/tailscale" --socket="$SOCK" status | head -5
echo "Connected. Try: ssh pi hostname"
