# Pi backend: instructions for Claude sessions

This repo is the infrastructure-as-code for Kushagra's Raspberry Pi 5 (4 GB RAM,
128 GB SD, 32 GB USB pendrive). Goal: an always-on, self-hosted dev backend so
projects never pause (replacing Supabase cloud free tier). If you are running
**on the Pi itself**, you have a real shell: inspect before you change anything.

## Hard rules

- **Free and open source only.** No paid tiers, trials or anything with a card on file.
- **Never commit secrets.** `.env`, JWT keys, tunnel credentials, SSH keys, dumps.
  This repo is **public**; gitleaks hooks guard commits (`scripts/install-secret-scan.sh`).
  A leaked secret must be rotated, not just deleted.
- **Never format a disk** without the owner's explicit approval in chat.
- **Check in at each milestone.** No silent giant changes. Ask before granting
  broader access than described here, or before switching tools (e.g. Coolify → Dokploy).
- **Tell honest limits.** He prefers that to reassurance.
- If what you find on the Pi contradicts this file, say so and ask.

## Architecture (agreed)

- Vercel stays **primary** for app frontends; the Pi is the always-on database
  and the **fallback** self-host layer. "Pi offline" is a rare edge case; don't
  over-engineer for it.
- Server model, not serverless.

## Build order and status

| Step | What | Where | Status |
|---|---|---|---|
| 0 | Inspect + clean the Pi | `scripts/00-inspect.sh` | **done 2026-10-24.** Debian 13 trixie 64-bit, 4K-page kernel8. Removed CasaOS, all its Docker apps (Immich, n8n, AdGuard, Syncthing, MySpeed, cloudflared-web), Ollama, OVOS, raspotify; disabled cups, Samba, desktop autologin (console boot). Kept SSH, Tailscale (logged out), Raspberry Pi Connect. Backups of all prior data in `~stdio/pre-cleanup/`. Pendrive formatted ext4 (`pidata`) at `/mnt/data` by UUID with `nofail`. Memory cgroup added to cmdline (needs reboot). **Power supply under-voltage seen (throttled=0x50000)**: owner to replace PSU |
| 1 | Self-hosted Supabase (official docker stack), zram, memory cgroup (reboot), pendrive at `/mnt/data`, nightly `pg_dump` 03:30 | `supabase/` (read its README) | prepare step done (memory cgroup active after reboot, log rotation, pendrive); `01-install-supabase.sh` running 2026-10-24 into `~/supabase-project` |
| 2 | SSH hardening: key-only, no root login, fail2ban, dedicated revocable agent key. Port 22 never public. `docker` group = root: say so once, let him decide | `ssh/` (todo) | not started |
| 3 | Coolify as fallback deploy target **only if RAM allows** with Supabase running; else ask about Dokploy/CapRover/compose+Caddy | `deploy/` (todo) | not started |
| 4 | Free subdomain + Cloudflare named tunnel → gateway :8000, dashboards, SSH via Access. Then update `SUPABASE_PUBLIC_URL`, `API_EXTERNAL_URL`, `SITE_URL` | `cloudflared/`, `docs/remote-access.md` | **blocked: no domain on the owner's Cloudflare account yet** (kushagra.dpdns.org NS point at Cloudflare but the site isn't added). Interim: `quick-tunnel.service` (trycloudflare, key-only SSH), address via `pi-url` |
| + | Pi Console dashboard (`dashboard/`): stats, Claude Code sessions via tmux + browser terminal, Docker, links, backups. Port 7070, LAN only until Layer 4 | `dashboard/` | **installed on the Pi 2026-10-24** (systemd `pi-console`, http://192.168.1.91:7070). Password generated into `~/pi-console-password.txt` for the owner to read and delete. `stdio` added to the `docker` group with owner approval |
| 5 | Nightly config sync to this repo: gitleaks scan, commit only on change, deploy key scoped to this repo. Test a full restore | `cron/` (todo) | not started |

## Known risks to check

- Pi 5 default kernel uses 16K pages (`getconf PAGESIZE`); jemalloc software can
  crash. Fix: `kernel=kernel8.img` in `/boot/firmware/config.txt` + reboot (ask first).
- Supabase idles ~2-2.5 GB; measure with `docker stats` / `free -h` before Layer 3.
- Multiple apps share one Supabase via schemas (`supabase/new-project.sh`); RLS on every table.
- Restore from a full `pg_dump` into a fresh install is untested.

## Git

Work on a branch and open a PR; don't push to `main` directly. Run
`scripts/install-secret-scan.sh` once per clone so the hooks are active.
