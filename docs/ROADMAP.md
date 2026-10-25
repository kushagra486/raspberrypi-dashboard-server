# Roadmap: optimisations and features

Proposal from 2026-10-25. Nothing here is built yet; the owner picks what goes first.
Rule of thumb: features added to **Pi Console** cost almost no RAM (same Node process);
every **new service** costs RAM on a 4 GB Pi, so each one must earn its place.

## How the system works today

```
App on Vercel / phone ──https──▶ raspberrypi.tailc40262.ts.net  (Tailscale Funnel, only /rest /auth /storage /realtime /functions /graphql)
                                        │
                                        ▼
                               Kong gateway :8000 ──▶ PostgREST (REST)   ─┐
                                                   ├▶ GoTrue (Auth)       │
                                                   ├▶ Storage (+imgproxy) ├─▶ Postgres 17
                                                   ├▶ Realtime            │   one schema per app, RLS on every table
                                                   └▶ Edge Functions     ─┘
Your devices (Tailscale) ──▶ Studio :8000 (full Supabase dashboard, private)
                         ──▶ Pi Console :9443 (stats, Database, Claude/shell sessions, Docker, backups)
Nightly 03:30 ──▶ pg_dump + .env ──▶ /mnt/data/backups (pendrive)
```

## A. Fixes and optimisations (cheap, high value)

| # | What | Why |
|---|---|---|
| A1 | **Real email for Auth**: free SMTP (Gmail app password, or Brevo free tier, no card) | Today SMTP is a fake placeholder and email confirmation is on, so email sign-ups cannot complete |
| A2 | `SITE_URL` / `ADDITIONAL_REDIRECT_URLS` per app | Still `localhost:3000`; auth redirects break in production |
| A3 | ~~Postgres tuned for 4 GB~~ **already done** in `supabase/docker-compose.pi.yml`; `pg_stat_statements` comes with B2 | |
| A4 | ~~Turn off analytics/vector~~ **already off** (not in the stack, saves ~1 GB) | |
| A5 | zram swap: set up by `00-prepare-pi.sh`; `system/harden.sh check` shows it | |
| A6 | Off-site encrypted backup (rclone → Google Drive free 15 GB) + **tested restore** | Backups now live on the same Pi; restore was never tested |
| A7 | Alerts to your phone (ntfy, free): Pi down, disk > 85 %, backup failed, under-voltage | You hear about problems before an app breaks |
| A8 | Close Kong's LAN port 8443 (bind to 127.0.0.1), unattended security upgrades | Smaller attack surface |
| A9 | SSH hardening + fail2ban (build step 2) | Already planned |

Hardware (owner): **official 27 W PSU** (critical: under-voltage corrupts SD cards);
later a **USB SSD** for Postgres/Docker (the single biggest speed and reliability upgrade).

### Phase A runbook (run on the Pi, in your own terminal, from `~/raspberrypi-dashboard-server`)

`git pull` first. Each step is independent; stop after any of them.

| Step | Command | You need |
|---|---|---|
| A1 email | `supabase/set-smtp.sh` then `supabase/set-smtp.sh --test you@gmail.com` | Gmail App Password (or Brevo SMTP login) |
| A2 redirects | `supabase/auth-urls.sh site https://<app>.vercel.app` and `supabase/auth-urls.sh add 'https://<app>.vercel.app/**'` | your app URL (per app, when you connect one) |
| A6 off-site | **Private GitHub repo** (chosen 2026-10-25): create an empty private repo, then `supabase/offsite-github-setup.sh kushagra486/pi-backups` (age-encrypted, deploy key limited to that repo, nightly 04:15, repo keeps only the newest 14). Then `supabase/restore-test.sh`. Alternatives kept: laptop pull `tools/windows/pull-pi-backups.ps1`; Google Drive `supabase/offsite-setup.sh` (needs Drive API) | empty private repo; save the decryption key in Bitwarden |
| A7 alerts | `monitor/install.sh` | ntfy app on the phone; optional free healthchecks.io check |
| A8 ports | `system/harden.sh check`, `system/harden.sh kong-8443`, `system/harden.sh auto-updates` | nothing |

All scripts back up `.env` before editing it, never print secrets, and restart only the
service they change.

## B. Pi Console features, borrowed from the best platforms

| # | Feature | Borrowed from |
|---|---|---|
| B1 ✅ | **Advisors**: RLS off, tables without policies, missing FK indexes, unused indexes, exposed schemas | Supabase Advisors (splinter lints) |
| B2 ✅ | **Query insights**: slowest / most frequent queries | Neon, PlanetScale Insights |
| B3 ✅ | **Table editor**: inline edit, insert row, CSV import/export | Supabase / Airtable / PocketBase |
| B4 | **Branch an app**: copy schema (+ optional data) to `app_dev`, reset, delete | Neon branching, Supabase branching |
| B5 ✅ | **Connect to Vercel**: one click shows/copies the env block for an app (URL, publishable key, schema) | Vercel / Supabase "Connect" |
| B6 ✅ | **Backups**: run now, download, **restore into a test schema**, off-site status | Railway / Supabase backups |
| B7 | **Schema diagram** (tables + foreign keys) | Supabase visualizer, dbdiagram |
| B8 | **Saved SQL snippets** + migration history (`supabase_migrations`) | Supabase SQL editor, Prisma |
| B9 | **Usage per app**: rows, size, storage per bucket, API requests (from Kong logs) | Firebase / Supabase usage |
| B10 | **Uptime & alerts page** (A7 history) | Uptime Kuma, Better Stack |
| B11 | **Audit log** of Pi Console actions (who ran what SQL / restarted what) | Supabase audit logs, GitHub |
| B12 | **Auth admin**: invite, ban, reset password, auth settings per app | Supabase Auth, Clerk |

## C. Bigger pieces (cost RAM or need decisions)

| # | What | Note |
|---|---|---|
| C1 | **Point-in-time recovery** (WAL archiving with wal-g/pgBackRest) | Supabase Pro feature; restore to any minute |
| C2 | **App hosting fallback** (build step 3): Coolify is heavy; Dokploy or compose + Caddy are lighter | Measure RAM first |
| C3 | **Logs explorer** across services | Needs analytics stack (~0.5 GB) or a light Loki; probably skip |

## Honest limits

- The Pi already runs the **real** Supabase, and Studio is the full Supabase dashboard.
  Re-coding all of Studio inside Pi Console would duplicate it and cost RAM; Pi Console
  should add what Studio lacks (B1, B4, B6, B9, B10, B11) and stay small.
- Cloud-only Supabase features (managed multi-region, read replicas, global CDN, SOC2)
  cannot be replicated on one Pi.
- One Pi = one point of failure. Off-site backups (A6) + PITR (C1) are the mitigation.
