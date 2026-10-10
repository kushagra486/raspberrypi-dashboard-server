#!/usr/bin/env bash
# Read-only inspection of the Pi before anything is installed.
# Changes nothing. Prints no secrets (no .env contents, no container env vars).
#
#   bash scripts/00-inspect.sh 2>&1 | tee inspect-report.txt
#
# Some checks need root; they use `sudo -n` and are skipped if sudo would prompt.
# Run `sudo -v` first to include them.

set -u

section() { printf '\n===== %s =====\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
run() { "$@" 2>&1 || true; }
sudo_run() {
  if sudo -n true 2>/dev/null; then sudo -n "$@" 2>&1 || true
  else echo "(skipped: needs sudo; run 'sudo -v' first)"; fi
}

section "Host"
run date -u
run hostname
[ -r /proc/device-tree/model ] && { tr -d '\0' < /proc/device-tree/model; echo; }
run uname -a
echo "arch: $(uname -m)"
echo "userland bits: $(getconf LONG_BIT)"
echo "page size: $(getconf PAGESIZE)   # 16384 = Pi 5 16K-page kernel (some images break; 4096 is safest)"
run cat /etc/os-release
run uptime

section "Boot config"
for f in /boot/firmware/cmdline.txt /boot/cmdline.txt; do
  [ -r "$f" ] && { echo "$f:"; cat "$f"; }
done
for f in /boot/firmware/config.txt /boot/config.txt; do
  [ -r "$f" ] && { echo "$f (non-comment lines):"; grep -Ev '^\s*(#|$)' "$f"; }
done

section "Memory, swap, zram"
run free -h
run swapon --show
have zramctl && run zramctl
echo "vm.swappiness=$(cat /proc/sys/vm/swappiness)"
echo "cgroup controllers: $(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null || echo 'cgroup v2 not mounted')"

section "Disks and mounts"
run lsblk -f
run df -hT -x tmpfs -x devtmpfs
echo "--- /etc/fstab (non-comment) ---"
grep -Ev '^\s*(#|$)' /etc/fstab 2>/dev/null || true
echo "--- /mnt/data ---"
if mountpoint -q /mnt/data 2>/dev/null; then
  findmnt -no SOURCE,FSTYPE,OPTIONS /mnt/data
  run ls -la /mnt/data
else
  echo "/mnt/data is NOT a mountpoint"
fi

section "CPU temperature / throttling"
have vcgencmd && { run vcgencmd measure_temp; run vcgencmd get_throttled; }

section "Docker"
if have docker; then
  run docker --version
  run docker compose version
  echo "user in docker group: $(id -nG | grep -qw docker && echo yes || echo no)"
  D="docker"; docker info >/dev/null 2>&1 || D="sudo -n docker"
  $D info --format 'storage={{.Driver}} root={{.DockerRootDir}} cgroup={{.CgroupDriver}}/v{{.CgroupVersion}} mem_limit_support={{.MemoryLimit}} swap_limit_support={{.SwapLimit}}' 2>&1 || echo "(docker info unavailable)"
  echo "--- containers ---"
  $D ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>&1 || true
  echo "--- compose projects ---"
  $D compose ls -a 2>&1 || true
  echo "--- images ---"
  $D images --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}' 2>&1 || true
  echo "--- volumes ---"
  $D volume ls 2>&1 || true
  echo "--- usage ---"
  $D system df 2>&1 || true
  echo "--- live stats ---"
  $D stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' 2>&1 || true
  echo "--- daemon.json ---"
  cat /etc/docker/daemon.json 2>/dev/null || echo "(none)"
else
  echo "docker: not installed"
fi

section "Existing Supabase / kit checkouts (paths only)"
for d in ~/supabase ~/supabase-project ~/pi-supabase-kit /opt/supabase /srv/supabase; do
  [ -e "$d" ] && { echo "found: $d"; ls -la "$d" 2>&1 | head -30; }
done
find ~ -maxdepth 3 -name 'docker-compose*.yml' -not -path '*/node_modules/*' 2>/dev/null | head -20

section "Listening ports"
sudo_run ss -tulpn
echo "--- unprivileged view ---"
run ss -tuln
echo "--- ports of interest (22 80 443 3000 5432 6543 8000 8443) ---"
ss -tuln 2>/dev/null | awk 'NR>1{print $5}' | grep -E ':(22|80|443|3000|5432|6543|8000|8443)$' || echo "none"

section "SSH"
run systemctl is-active ssh
sudo_run sshd -T | grep -Ei '^(port|passwordauthentication|permitrootlogin|pubkeyauthentication|kbdinteractiveauthentication|maxauthtries|allowusers|allowgroups) '
echo "authorized_keys entries for $(id -un): $(grep -cE '^(ssh|ecdsa|sk-)' ~/.ssh/authorized_keys 2>/dev/null || echo 0)"
echo "local users with a login shell:"
awk -F: '$7 !~ /(nologin|false)$/ {print "  " $1 " uid=" $3}' /etc/passwd

section "Security / networking tools"
for t in fail2ban-client ufw nft iptables cloudflared tailscale caddy nginx coolify git cron unattended-upgrade; do
  printf '%-20s %s\n' "$t" "$(command -v "$t" || echo '-')"
done
for s in fail2ban cloudflared tailscaled unattended-upgrades cron nginx caddy; do
  printf 'service %-20s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null)"
done
sudo_run ufw status

section "Cron (current user)"
crontab -l 2>/dev/null || echo "(no crontab)"

section "Network"
run ip -br addr
echo "default route: $(ip route show default 2>/dev/null)"
echo "internet: $(curl -fsS -m 5 -o /dev/null -w '%{http_code}' https://github.com 2>/dev/null || echo unreachable)"

section "Done"
echo "Paste this whole report back to Claude. Review it first: it contains hostnames and LAN IPs, but no secrets."
