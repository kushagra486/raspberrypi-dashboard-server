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

## Skill

`.claude/skills/pi-backend/` is the portable skill for reaching and operating the Pi
from any session (connect script + `pi.sh` ops). Keep it in sync when infra facts change,
and rebuild the upload zip (`pi-backend-skill.zip`, gitignored) for claude.ai.

## Owner to-do

Open items only the owner can do are in [docs/TODO.md](docs/TODO.md)
(passwords to a password manager, Tailscale key expiry, power supply, ...).
Mention the relevant ones when they matter; don't nag every message.

## Architecture (agreed)

- Vercel stays **primary** for app frontends; the Pi is the always-on database
  and the **fallback** self-host layer. "Pi offline" is a rare edge case; don't
  over-engineer for it.
- Server model, not serverless.

## Build order and status

| Step | What | Where | Status |
|---|---|---|---|
| 0 | Inspect + clean the Pi | `scripts/00-inspect.sh` | **done 2026-10-24.** Debian 13 trixie 64-bit, 4K-page kernel8. Removed CasaOS, all its Docker apps (Immich, n8n, AdGuard, Syncthing, MySpeed, cloudflared-web), Ollama, OVOS, raspotify; disabled cups, Samba, desktop autologin (console boot). Kept SSH, Tailscale (logged out), Raspberry Pi Connect. Backups of all prior data in `~stdio/pre-cleanup/`. Pendrive formatted ext4 (`pidata`) at `/mnt/data` by UUID with `nofail`. Memory cgroup added to cmdline (needs reboot). **Power supply under-voltage seen (throttled=0x50000)**: owner to replace PSU |
| 1 | Self-hosted Supabase (official docker stack) | `supabase/` (read its README) | **running on the Pi since 2026-10-24** in `~/supabase-project` (self-hosted v0.8.3, Postgres 17): 11 services healthy, ~1.3 GB RAM, 2.3 GB still free. **Gateway is Kong, not Envoy** (Envoy's tcmalloc needs 48-bit VA; the 4K kernel has 39-bit). Storage on `/mnt/data/supabase-storage`; `.env` mode 600; nightly `pg_dump` 03:30 to `/mnt/data/backups` (first dump verified). Studio + API on http://192.168.1.91:8000 |
| 2 | SSH hardening: key-only, no root login, fail2ban, dedicated revocable agent key. Port 22 never public. `docker` group = root: say so once, let him decide | `ssh/` (todo) | not started |
| 3 | Coolify as fallback deploy target **only if RAM allows** with Supabase running; else ask about Dokploy/CapRover/compose+Caddy | `deploy/` (todo) | not started |
| 4 | Remote access | `tailscale/`, `docs/remote-access-tailscale.md` | **done 2026-10-24 with Tailscale** (owner has no domain; kushagra.dpdns.org was taken). Pi on tailnet as `raspberrypi` / `raspberrypi.tailc40262.ts.net`. **Funnel publishes only the Supabase API paths** (verified from the internet: API works with key, RLS enforced, Studio/pg-meta 404). Studio, Pi Console, SSH private to tailnet. `SUPABASE_PUBLIC_URL` / `API_EXTERNAL_URL` point at the Funnel URL. **Claude cloud sessions: `source tailscale/claude-connect.sh` then `ssh pi`** (needs `TS_AUTHKEY` in the environment: tag:claude, ephemeral, reusable; verified 2026-10-24, docs/claude-session-access.md). The temporary trycloudflare `quick-tunnel.service`, `pi-url` and the old `claude-cloud-agent` SSH key were removed 2026-10-24. Owner applied the policy 2026-10-24; Pi tagged `tag:pi`, Tailscale SSH on (`RunSSH`), Funnel unaffected. **No domain and no Cloudflare: owner decision 2026-10-24** (does not want to buy a domain; free ones are not usable). Do not propose a domain again unless he asks. `cloudflared/` files are dormant |
| + | Pi Console dashboard (`dashboard/`): stats, Claude Code sessions via tmux + browser terminal, Docker, links, backups. Port 7070, LAN + tailnet (`http://raspberrypi:7070`), never on Funnel | `dashboard/` | **installed on the Pi 2026-10-24** (systemd `pi-console`, http://192.168.1.91:7070). Password generated into `~/pi-console-password.txt` for the owner to read and delete. `stdio` added to the `docker` group with owner approval. **2026-10-25: Database section + installable app deployed** (Pi at `bcb8977`); app address **https://raspberrypi.tailc40262.ts.net:9443** (Tailscale Serve, tailnet only; 8443 is taken by Kong's HTTPS listener). Password reset by owner via `npm run set-password` |
| 5 | Nightly config sync to this repo: gitleaks scan, commit only on change, deploy key scoped to this repo. Test a full restore | `cron/` (todo) | not started |

## Known risks to check

- Pi 5 default kernel uses 16K pages (`getconf PAGESIZE`); jemalloc software can
  crash. Fix: `kernel=kernel8.img` in `/boot/firmware/config.txt` + reboot (ask first).
- Supabase idles ~2-2.5 GB; measure with `docker stats` / `free -h` before Layer 3.
- Multiple apps share one Supabase via schemas (`supabase/new-project.sh`); RLS on every table.
- Restore from a full `pg_dump` into a fresh install is untested (dump is readable with `pg_restore --list`).
- Kong's HTTPS listener binds 0.0.0.0:8443 (LAN-reachable, self-signed; not internet). Owner to decide whether to bind it to 127.0.0.1.
- Supabase `.env` was pasted into a private Claude chat 2026-10-25; owner decided **not** to rotate (accepted risk). Don't push rotation again; rotate only if he asks or a key is seen outside that chat.
- Power supply under-voltage at every boot (`vcgencmd get_throttled` = 0x50000) until the owner swaps the PSU.

## Git

Work on a branch and open a PR; don't push to `main` directly. Run
`scripts/install-secret-scan.sh` once per clone so the hooks are active.
