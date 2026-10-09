#!/usr/bin/env bash
# Step 1: prepare a Raspberry Pi 5 (4 GB) for self-hosted Supabase.
#
#   - checks the board / OS
#   - mounts your pendrive permanently (by UUID) at /mnt/data
#   - enables the memory cgroup (needed for Docker memory limits)
#   - turns on zram compressed swap (stretches 4 GB of RAM)
#   - installs Docker + the compose plugin
#
# Usage:   sudo ./00-prepare-pi.sh /dev/sda1
# The pendrive partition must already be ext4. This script NEVER formats a disk.
set -euo pipefail

PEN_DEV="${1:-}"
MOUNT_POINT="/mnt/data"

log()  { printf '===> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "run with sudo: sudo ./00-prepare-pi.sh /dev/sda1"
[ "$(uname -m)" = "aarch64" ] || die "expected a 64-bit OS (aarch64), got $(uname -m). Install Raspberry Pi OS Lite 64-bit."
[ -n "$PEN_DEV" ] || { lsblk -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINT; die "pass your pendrive partition, e.g. sudo ./00-prepare-pi.sh /dev/sda1"; }
[ -b "$PEN_DEV" ] || die "$PEN_DEV is not a block device"

# ---------------------------------------------------------------- pendrive
FSTYPE="$(blkid -o value -s TYPE "$PEN_DEV" || true)"
UUID="$(blkid -o value -s UUID "$PEN_DEV" || true)"
[ -n "$UUID" ] || die "could not read a UUID from $PEN_DEV (is it formatted?)"

if [ "$FSTYPE" != "ext4" ]; then
  cat >&2 <<EOF
ERROR: $PEN_DEV is '$FSTYPE', not ext4.
Postgres backups and Supabase Storage need a Linux filesystem (FAT/exFAT lose
permissions). If the stick holds nothing you need, format it yourself:

    sudo umount $PEN_DEV 2>/dev/null
    sudo mkfs.ext4 -L pidata $PEN_DEV      # ERASES everything on $PEN_DEV

then run this script again.
EOF
  exit 1
fi

mkdir -p "$MOUNT_POINT"
if ! grep -q "UUID=$UUID" /etc/fstab; then
  log "adding $PEN_DEV (UUID=$UUID) to /etc/fstab"
  # nofail: the Pi still boots if the stick is unplugged
  echo "UUID=$UUID $MOUNT_POINT ext4 defaults,noatime,nofail,x-systemd.device-timeout=10 0 2" >> /etc/fstab
fi
mountpoint -q "$MOUNT_POINT" || mount "$MOUNT_POINT"
mountpoint -q "$MOUNT_POINT" || die "failed to mount $MOUNT_POINT"

mkdir -p "$MOUNT_POINT/supabase-storage" "$MOUNT_POINT/backups"
# the storage containers run as non-root users; this stick is dedicated to this job
chmod 0777 "$MOUNT_POINT/supabase-storage"
chmod 0700 "$MOUNT_POINT/backups"
log "pendrive mounted at $MOUNT_POINT ($(df -h --output=size,avail "$MOUNT_POINT" | tail -1 | xargs))"

# ---------------------------------------------------------------- cgroups
CMDLINE=/boot/firmware/cmdline.txt
[ -f "$CMDLINE" ] || CMDLINE=/boot/cmdline.txt
if [ ! -e /sys/fs/cgroup/cgroup.controllers ] || ! grep -qw memory /sys/fs/cgroup/cgroup.controllers; then
  if [ -f "$CMDLINE" ] && ! grep -q 'cgroup_enable=memory' "$CMDLINE"; then
    log "enabling the memory cgroup in $CMDLINE (needs a reboot)"
    sed -i '1 s/$/ cgroup_enable=memory cgroup_memory=1/' "$CMDLINE"
    NEED_REBOOT=1
  fi
fi

# ---------------------------------------------------------------- zram swap
if ! swapon --show=NAME --noheadings | grep -q zram; then
  log "installing zram swap"
  apt-get update -y
  apt-get install -y zram-tools
  cat > /etc/default/zramswap <<'EOF'
ALGO=zstd
PERCENT=50
PRIORITY=100
EOF
  systemctl enable --now zramswap || true
else
  log "zram swap already active"
fi
# keep the kernel from swapping aggressively to flash
echo 'vm.swappiness=20' > /etc/sysctl.d/99-pi-supabase.conf
sysctl -p /etc/sysctl.d/99-pi-supabase.conf >/dev/null

# ---------------------------------------------------------------- docker
if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker Engine"
  apt-get install -y ca-certificates curl
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
fi
docker compose version >/dev/null 2>&1 || apt-get install -y docker-compose-plugin

# keep container logs small so they don't fill the SD card
mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
EOF
  systemctl restart docker
fi

TARGET_USER="${SUDO_USER:-}"
if [ -n "$TARGET_USER" ] && ! id -nG "$TARGET_USER" | grep -qw docker; then
  usermod -aG docker "$TARGET_USER"
  log "added $TARGET_USER to the docker group (log out and back in once)"
fi

echo
log "Pi is prepared."
if [ "${NEED_REBOOT:-0}" = "1" ]; then
  warn "A reboot is required for the memory cgroup:  sudo reboot"
  warn "After rebooting, continue with: ./01-install-supabase.sh"
else
  log "Next: ./01-install-supabase.sh"
fi
