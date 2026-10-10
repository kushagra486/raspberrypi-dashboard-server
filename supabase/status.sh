#!/usr/bin/env bash
# Quick health view: temperature, memory, swap, disks, containers.
PROJECT_DIR="${PROJECT_DIR:-$HOME/supabase-project}"

echo "== Pi =="
command -v vcgencmd >/dev/null && vcgencmd measure_temp
free -h | sed -n '1,2p;3p'
swapon --show
echo
echo "== Disks =="
df -h / /mnt/data 2>/dev/null
echo
echo "== Containers =="
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' 2>/dev/null
echo
cd "$PROJECT_DIR" 2>/dev/null && sh run.sh status
echo
echo "== Last backup =="
ls -1t /mnt/data/backups/db-*.dump 2>/dev/null | head -1
