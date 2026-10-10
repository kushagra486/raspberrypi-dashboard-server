# raspberrypi-dashboard-server

Infrastructure-as-code for the Raspberry Pi 5 (4 GB) always-on dev backend:
self-hosted Supabase, agent SSH access, a fallback deploy layer, and a
Cloudflare Tunnel. Vercel stays primary for apps; the Pi is the always-on
database and the fallback host.

This repo holds **configuration only**. Secrets (`.env`, JWT keys, tunnel
credentials, SSH keys, dumps) are gitignored and are backed up separately.

## Status

| Step | Layer | State |
|---|---|---|
| 0 | Fresh headless OS install ([docs/fresh-install.md](docs/fresh-install.md)), then inspect (`scripts/00-inspect.sh`) | **next** |
| 1 | Self-hosted Supabase + zram, cgroups, pendrive, backups (`supabase/`) | kit reviewed against upstream; not yet run on the Pi |
| 2 | SSH hardening + dedicated agent key | not started |
| 3 | Coolify, or a lighter substitute if RAM won't allow | not started |
| 4 | Free subdomain + Cloudflare named tunnel | not started |
| 5 | Nightly config backup to this repo | not started |

Each step is reviewed with the owner before running on the Pi.

## Secret scanning (public repo)

This repo is public, so three layers keep secrets out of it:

- **Local hooks** (`.githooks/`): gitleaks scans staged changes before every
  commit and every commit before a push. Enable once per clone:
  `scripts/install-secret-scan.sh` (installs a pinned, checksum-verified
  gitleaks and sets `core.hooksPath`). The nightly config sync (step 5) runs
  the same scan and refuses to push on a finding.
- **CI** (`.github/workflows/secret-scan.yml`): scans the full history on
  every push and PR.
- **GitHub push protection**: Settings → Code security → enable *Secret
  scanning* and *Push protection*.

Rules live in `.gitleaks.toml`: gitleaks defaults plus Supabase `sb_secret_`
keys, cloudflared `TunnelSecret`, any committed `.env`, and weak
`*PASSWORD*=`/`*SECRET*=`/`*TOKEN*=` values. A hit means **rotate the secret**:
once pushed to a public repo, assume it is compromised even if the commit
is removed.

## Step 0: inspect

On the Pi:

```bash
git clone https://github.com/kushagra486/raspberrypi-dashboard-server.git
cd raspberrypi-dashboard-server
sudo -v   # optional: lets the script include root-only checks
bash scripts/00-inspect.sh 2>&1 | tee inspect-report.txt
```

The script is read-only: it installs, edits and restarts nothing, and prints no
secret values. Read the report and paste it back.

## Planned layout

```
scripts/      00-inspect.sh (read-only report), install-secret-scan.sh
supabase/     Layer 1 kit: prepare, install, backups, compose override (see supabase/README.md)
ssh/          sshd_config drop-in, fail2ban jail
cloudflared/  config.yml (no credentials JSON)
deploy/       Coolify export or compose + Caddy for the substitute
cron/         crontab entries (DB backup 03:30, config sync)
```

## Rebuild from scratch (to be filled in as each layer lands)

1. Flash the OS headless per [docs/fresh-install.md](docs/fresh-install.md), mount the pendrive at `/mnt/data` (ext4, by UUID, `nofail`).
2. Restore secrets from the off-Pi copy.
3. Run `supabase/00-prepare-pi.sh`, `01-install-supabase.sh`, `02-install-backups.sh`, then later layers.
4. Restore the latest `pg_dump` from `/mnt/data/backups` (or the off-Pi copy).
