# Pi Console

One dashboard for the Pi, in the browser, on any device.

| Tab | What it does |
|---|---|
| **Overview** | CPU, memory, swap, temperature, disks (SD card and pendrive), uptime and load. Refreshes every 5 s. |
| **Database** | Supabase Postgres at a glance: version, size, connections, auth users, storage, latest backup. **Projects** (one schema per app) with API exposure and **tables missing RLS flagged**; tables → columns, keys, policies, paged rows; **SQL editor** (read-only by default, 30 s timeout, 1000-row cap); auth users (no password hashes); storage buckets; *Create project* (runs `supabase/new-project.sh`). Full editing stays in Supabase Studio, linked. |
| **Claude** | Start a **Claude Code** (or plain shell) session in any project folder, see all running sessions, open any of them in a full terminal in the browser, end them. Also creates new project folders. |
| **Services** | Every Docker container (Supabase and anything else): state, ports, start / stop / restart, last 300 log lines. |
| **Apps** | One-click links to Supabase Studio, the API, and anything you add in `config.json`. |
| **Backups** | Database dumps in `/mnt/data/backups`, newest first, with size and age. |

Sessions live in **tmux**. Closing the tab, losing Wi-Fi or restarting the dashboard only
detaches; the session keeps running and you can reopen it from your phone or laptop.

Supabase's own dashboard (Studio) is linked, not rebuilt: it already is the full
Supabase UI (tables, SQL editor, auth, storage), and a copy would cost RAM the Pi lacks.

## Install it as an app

Open `https://raspberrypi.tailc40262.ts.net:8443` (Tailscale Serve: HTTPS, tailnet-only) and choose
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
```
