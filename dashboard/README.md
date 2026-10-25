# Pi Console

One dashboard for the Pi, in the browser, on any device.

| Tab | What it does |
|---|---|
| **Overview** | CPU, memory, swap, temperature, disks (SD card and pendrive), uptime and load. Refreshes every 5 s. |
| **Database** | Supabase Postgres at a glance: version, size, connections, auth users, storage, latest backup. **Organizations** (folders of projects: create, rename, delete when empty, move projects between them; stored in the private `pi_console` schema so backups include them) with **Projects** (one schema per app, created inside an organization) with API exposure and **tables missing RLS flagged**; tables → columns, keys, policies, paged rows; **SQL editor** (read-only by default, 30 s timeout, 1000-row cap); auth users (no password hashes); storage buckets; *Create project* (runs `supabase/new-project.sh`); **Advisors** (RLS gaps, policies with RLS off, unindexed foreign keys, duplicate/unused indexes, missing primary keys, mutable function search_path, extensions in public; each with a fix you can open in the SQL editor); **Query insights** (slowest / most frequent queries from `pg_stat_statements`, passwords masked); **Connect** per project (the env block for Vercel with the public key only, plus warnings if the schema is not exposed or tables lack RLS); **table editor** (add / edit / delete rows by primary key, CSV export, all-or-nothing CSV import); **Branch** an app into `<app>_dev` (tables, keys, indexes, RLS, policies, optionally rows; exposed through the API; reset or delete it later; only `_dev` schemas can be deleted); **Diagram** of a schema's tables and foreign keys (SVG download); **saved SQL snippets** (stored on the Pi in `~/.local/share/pi-console`) and the Supabase CLI **migration history**. Full editing stays in Supabase Studio, linked. |
| **Claude** | Start a **Claude Code** (or plain shell) session in any project folder, see all running sessions, open any of them in a full terminal in the browser, end them. Also creates new project folders. |
| **Services** | Every Docker container (Supabase and anything else): state, ports, start / stop / restart, last 300 log lines. |
| **Apps** | One-click links to Supabase Studio, the API, and anything you add in `config.json`. |
| **Backups** | Database dumps in `/mnt/data/backups`, newest first. **Back up now**, **Test restore** (restores a dump into a throw-away database and compares row counts; live data untouched), **Download** a dump; when the last off-site copy and the last passing restore test happened. `.env` copies are never downloadable. |

Sessions live in **tmux**. Closing the tab, losing Wi-Fi or restarting the dashboard only
detaches; the session keeps running and you can reopen it from your phone or laptop.

Supabase's own dashboard (Studio) is linked, not rebuilt: it already is the full
Supabase UI (tables, SQL editor, auth, storage), and a copy would cost RAM the Pi lacks.

## Install it as an app

Open `https://raspberrypi.tailc40262.ts.net:9443` (Tailscale Serve: HTTPS, tailnet-only) and choose
**Install app** (Chrome/Edge) or **Share → Add to Home Screen** (iPhone). It opens in its own
window with its own icon, on any device signed in to Tailscale.

## Install (on the Pi)

```bash
cd ~/raspberrypi-dashboard-server/dashboard
./install.sh
```

It installs tmux, Node.js and build tools, asks for a dashboard password (12+ chars;
only a scrypt hash is stored, in `dashboard/.env`, mode 600), and starts the
`pi-console` systemd service. Open `http://<pi-ip>:7070`.

- Logs: `journalctl -u pi-console -f`
- Change password: `npm run set-password && sudo systemctl restart pi-console`
- Settings: `config.json` (project folders, links, port, Claude path). Restart after editing.

## Security: read this

**A terminal in this dashboard is a full shell on the Pi** as your user, which can use
`sudo` and Docker. Treat the password like the Pi's own.

- Login: password, 5 wrong tries lock that IP out for 15 min, HttpOnly + SameSite=Strict
  session cookie, origin checks on every change and on the terminal socket, strict CSP.
- Sessions can only start inside the folders listed in `projectRoots`.
- Out of the box it listens on your **home network only**, over plain HTTP. Do not
  port-forward it.
- **Access from anywhere** comes with Layer 4: a Cloudflare named tunnel to
  `http://localhost:7070`, with **Cloudflare Access** (free) in front so only your
  email can reach the login page. Then set `"bind": "127.0.0.1"`, `"secureCookies": true`
  and add the tunnel URL to `allowedOrigins` in `config.json`.

## Develop / test

```bash
npm install
npm test        # boots the server and drives login, API, tmux sessions and the terminal socket
# Database tests need a local Postgres with pg_stat_statements preloaded:
psql -d postgres -f test/seed.sql && npm run test:db
```
