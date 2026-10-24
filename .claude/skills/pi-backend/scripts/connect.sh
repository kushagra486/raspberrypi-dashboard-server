#!/usr/bin/env bash
# Make `ssh pi` reach Kushagra's Raspberry Pi from wherever Claude is running.
#
#   source <skill-dir>/scripts/connect.sh
#
# 1. Laptop/desktop with the Tailscale app logged in  -> plain SSH to "raspberrypi".
# 2. Cloud session with TS_AUTHKEY (tag:claude key)    -> userspace tailscaled,
#    ephemeral node, SSH through `tailscale nc`.
# 3. Neither                                            -> explains what is missing.
# Idempotent: safe to source again. Never prints the auth key.

_pi_fail() { echo "pi-backend: $*" >&2; return 1 2>/dev/null || exit 1; }

PI_HOST="${PI_HOST:-raspberrypi}"
PI_USER="${PI_USER:-stdio}"
TS_VERSION="${TS_VERSION:-1.104.2}"
TS_BIN="${TS_BIN:-$HOME/.local/tailscale}"
TS_STATE="${TS_STATE_DIR:-$HOME/.cache/tailscale}"
TS_SOCK="$TS_STATE/tailscaled.sock"

_pi_write_ssh_config() {  # $1 = optional ProxyCommand
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  touch "$HOME/.ssh/config" && chmod 600 "$HOME/.ssh/config"
  # replace any previous "Host pi" block
  awk 'BEGIN{skip=0} /^Host /{skip=($2=="pi")} !skip' "$HOME/.ssh/config" > "$HOME/.ssh/config.tmp" \
    && mv "$HOME/.ssh/config.tmp" "$HOME/.ssh/config"
  {
    echo "Host pi"
    echo "  HostName $PI_HOST"
    echo "  User $PI_USER"
    [ -n "${1:-}" ] && echo "  ProxyCommand $1"
    echo "  StrictHostKeyChecking accept-new"
    echo "  ServerAliveInterval 30"
    echo "  ConnectTimeout 20"
  } >> "$HOME/.ssh/config"
}

# 1. A system Tailscale that is already connected (laptop / desktop).
if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1 \
   && tailscale status 2>/dev/null | grep -qw "$PI_HOST"; then
  _pi_write_ssh_config ""
  echo "pi-backend: using this machine's Tailscale."
# 2. Cloud session: join as an ephemeral tag:claude node.
elif [ -n "${TS_AUTHKEY:-}" ]; then
  if [ ! -x "$TS_BIN/tailscale" ]; then
    mkdir -p "$TS_BIN"
    arch=amd64; case "$(uname -m)" in aarch64|arm64) arch=arm64;; esac
    curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TS_VERSION}_${arch}.tgz" \
      | tar -xz -C "$TS_BIN" --strip-components=1 \
          "tailscale_${TS_VERSION}_${arch}/tailscale" "tailscale_${TS_VERSION}_${arch}/tailscaled" \
      || _pi_fail "could not download Tailscale (is pkgs.tailscale.com allowed by the network policy?)"
  fi
  mkdir -p "$TS_STATE"
  if ! "$TS_BIN/tailscale" --socket="$TS_SOCK" status >/dev/null 2>&1; then
    nohup "$TS_BIN/tailscaled" --tun=userspace-networking --state=mem: \
      --statedir="$TS_STATE" --socket="$TS_SOCK" >"$TS_STATE/tailscaled.log" 2>&1 &
    for _ in $(seq 1 30); do [ -S "$TS_SOCK" ] && break; sleep 0.5; done
    "$TS_BIN/tailscale" --socket="$TS_SOCK" up --authkey="$TS_AUTHKEY" \
      --hostname="claude-$(hostname | tr -cd 'a-z0-9' | tail -c 8)" --accept-dns=false \
      || _pi_fail "tailscale up failed: key expired or revoked? (see $TS_STATE/tailscaled.log)"
  fi
  _pi_write_ssh_config "$TS_BIN/tailscale --socket=$TS_SOCK nc %h %p"
  echo "pi-backend: joined the tailnet as an ephemeral tag:claude node."
else
  _pi_fail "no route to the Pi. Laptop: open the Tailscale app and sign in (darkbar4@gmail.com). Cloud: add TS_AUTHKEY (tag:claude, ephemeral, reusable) to this environment's variables and start a new session."
fi

ssh -o BatchMode=yes pi 'echo "pi-backend: connected to $(hostname) as $(whoami)"' \
  || _pi_fail "SSH to the Pi failed (Pi offline or power issue? policy changed?)"
