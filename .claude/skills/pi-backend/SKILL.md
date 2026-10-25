---
name: pi-backend
description: Connect to and operate Kushagra's always-on Raspberry Pi backend (self-hosted Supabase database + Pi Console dashboard) from any session. Use whenever the user mentions the Pi, "my server", "my database", self-hosted Supabase, Pi Console, wants an app to use his own backend instead of Supabase cloud, asks to run SQL, create tables or an app schema, get connection settings for an app or Vercel, check backups, or check whether the server is up.
---

# Pi backend

Kushagra (GitHub `kushagra486`) runs an always-on **Raspberry Pi 5 (4 GB)** as his
free, self-hosted backend. Vercel stays primary for app frontends; the Pi is the
always-on database. Infra repo: `github.com/kushagra486/raspberrypi-dashboard-server`
(its `CLAUDE.md` and `docs/TODO.md` hold the full status).

## Facts

| Thing | Value |
|---|---|
| Pi on Tailscale | `raspberrypi` / `raspberrypi.tailc40262.ts.net`, user `stdio`, tag `tag:pi` |
| **Public Supabase API** (Funnel) | `https://raspberrypi.tailc40262.ts.net` (only `/rest /auth /storage /realtime /functions /graphql` `/v1`) |
| Supabase Studio (private) | `http://raspberrypi:8000`, login `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` |
| **Pi Console app** (private) | `https://raspberrypi.tailc40262.ts.net:9443` (installable app, Tailscale Serve) or `http://raspberrypi:7070`: stats, **Database** (projects, tables + editor, RLS gaps, Advisors, query insights, Connect-to-Vercel, `_dev` branches, diagram, SQL editor with saved snippets, auth users, storage), Claude/shell sessions in tmux, Docker, backups |
| Supabase files | `~/supabase-project` (self-hosted v0.8.3, Postgres 17, **Kong** gateway) |
| Backups | nightly 03:30 → `/mnt/data/backups` (pendrive), `pg_dump -Fc` + `.env` |
| Apps | shared: one Postgres schema per app in the main database. **Isolated** (own database, own users, own keys): `supabase/isolated/iso-project.sh create NAME`, served at `https://raspberrypi.tailc40262.ts.net/p/NAME` (see `supabase/isolated/README.md`). Isolated projects can **auto-sleep** when idle (`iso-project.sh sleep-mode NAME auto|off [MIN]`, Pi Console → Capacity); first request after sleep takes ~1 s |

Private addresses work only on devices in his tailnet. No domain, no Cloudflare: his
decision. Do not suggest buying a domain.

## 1. Connect first

Shell available (Claude Code, cloud or laptop):

```bash
source "<this skill's directory>/scripts/connect.sh"
```

- Laptop with the Tailscale app on: plain SSH, nothing else needed.
- Cloud session: needs env var `TS_AUTHKEY` (reusable, ephemeral, tagged `tag:claude`).
  The policy lets `tag:claude` reach **only the Pi's SSH as `stdio`**.
- If it fails, relay its message. Missing key: the owner adds `TS_AUTHKEY` in the cloud
  environment's settings and starts a new session. Never ask him to paste the key in chat.

No shell (claude.ai chat, mobile): you cannot reach the Pi. Answer from the facts
above and give him the exact commands to run himself.

## 2. Operate

`<skill>/scripts/pi.sh`:

| Task | Command |
|---|---|
| Is everything up? | `pi.sh status` |
| Run SQL | `pi.sh sql "select ..."` or `pi.sh sql < migration.sql` |
| New app | `pi.sh new-app <name>` (lowercase, creates schema + API exposure) |
| Settings for an app / Vercel | `pi.sh app-config <name>` |
| Backups | `pi.sh backups`, `pi.sh backup-now` |
| Logs | `pi.sh logs supabase-rest 100` (containers: `supabase-db`, `-auth`, `-rest`, `-storage`, `-kong`, `-studio`, `-meta`, `-pooler`, `-edge-functions`, `realtime-dev.supabase-realtime`) |
| Anything else | `ssh pi '...'` (passwordless sudo; Docker; `cd ~/supabase-project && sh run.sh status\|restart\|logs`) |
| Deploying | Do it yourself (owner decision 2026-10-25): `ssh pi 'cd ~/raspberrypi-dashboard-server && git pull'`, then the steps the change needs (`cd dashboard && npm ci && sudo systemctl restart pi-console`; `supabase/isolated/iso-project.sh apply`). Ask first before destructive, exposing, secret-rotating or reboot actions (see CLAUDE.md) |

Wiring an app:
1. `pi.sh new-app myapp`
2. Create tables in schema `myapp` with **RLS enabled on every table** plus explicit
   policies. The publishable key is public.
3. `pi.sh app-config myapp`, then set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in the
   app (Vercel env vars), and `createClient(url, key, { db: { schema: 'myapp' } })`.
4. Auth redirects: add the app's URL to `ADDITIONAL_REDIRECT_URLS` (or `SITE_URL`) in
   `~/supabase-project/.env`, then `docker compose up -d` there.

## 3. Rules (he set these)

- **Free and open source only**; no paid tiers, nothing with a card.
- **Never print or commit secrets**: secret key, DB password, dashboard password,
  `.env`, auth keys. The publishable key may be shown and put in apps. If a secret leaks,
  rotate it on the Pi.
- **Ask before** anything destructive or hard to undo (dropping schemas/tables, deleting
  backups, formatting disks, reboots, `docker compose down -v`). Take a backup first
  (`pi.sh backup-now`).
- **Ask before** exposing anything new to the internet. Funnel must stay limited to the
  Supabase API paths; Studio, Pi Console and SSH stay private.
- **Mind the RAM:** 4 GB total, about 2.3 GB free with Supabase running. Check `pi.sh status`
  before adding services.
- Record infra changes in the infra repo (branch + PR, gitleaks hooks), not just on the Pi.
- Be honest about limits. If the Pi or home internet is down, the API is down;
  Vercel frontends stay up.
