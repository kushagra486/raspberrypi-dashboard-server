# Isolated projects: own database, own users, own keys

For apps whose users and data must never mix with any other app. Each isolated project gets:

| | |
|---|---|
| Database | `proj_<name>`: its own Postgres database, its own folder of files on disk |
| Users | Supabase Auth (GoTrue) writing into that database's `auth` schema only |
| API | its own PostgREST instance and its **own JWT secret**: a login or key from another project is rejected |
| Address | `https://raspberrypi.tailc40262.ts.net/p/<name>/auth/v1` and `/p/<name>/rest/v1` (supabase-js: `createClient('https://…/p/<name>', anonKey)`) |
| Keys | `~/supabase-project/isolated/projects/<name>/project.env` (mode 600). Pi Console → Connect shows the public key only |
| Backups | `/mnt/data/backups/<name>/` nightly, and encrypted into the `pi-backups` repo |
| Database logins | `iso_<name>_auth`, `iso_<name>_api`: can connect to `proj_<name>` only |

Cost: about 16-45 MB RAM per project (Auth + API) plus one shared 15 MB proxy (`iso-proxy`, port 8100 on
127.0.0.1). Roughly 15 projects fit comfortably next to the main stack on the 4 GB Pi.

Not included per project (yet): Storage (file uploads), Realtime, Edge Functions. Supabase Studio only shows the
main database: manage isolated projects in Pi Console (pick the project in the **Database** selector).

## First-time setup on the Pi

```bash
cd ~/raspberrypi-dashboard-server && git pull
cd dashboard && npm ci --omit=dev && sudo systemctl restart pi-console && cd ..

# 1. Lock the main database: from now on only the logins that exist today may connect to it
#    (isolated projects' logins never can). Undo: grant connect on database postgres to public;
supabase/isolated/iso-project.sh lockdown
supabase/status.sh                     # all Supabase containers still healthy?

# 2. Prove isolation with two throw-away projects (deleted again at the end). Expect 0 failed.
supabase/isolated/test-isolation.sh

# 3. Publish /p on the internet (only the proxy, which requires each project's key)
supabase/isolated/iso-project.sh funnel
```

After a Supabase upgrade that adds a new login role, run `iso-project.sh lockdown` again.

## Updating

After `git pull`, run `supabase/isolated/iso-project.sh apply` once: it regenerates the proxy config
(e.g. the request log used by Pi Console's Overview page: method, path without query string, status and
duration only; never keys or headers; capped at 30 MB).

## Everyday

- Create: Pi Console → Database → Projects → *+ New project* with **Own users & database** ticked,
  or `supabase/isolated/iso-project.sh create <name>`.
- Connect an app: Pi Console → *Connect* on the project (URL + public key for Vercel).
- Sign-in redirects for its app: `supabase/isolated/iso-project.sh site <name> https://<app>.vercel.app`
- Work in it: pick it in the **Database** selector; table editor, SQL editor, auth users, Advisors,
  query insights and diagram then act on that project's database only.
- Overview: Pi Console → Projects → *Overview*: users, sign-ups per day, active users, requests and errors
  per hour, size, largest tables, last backup, Advisors.
- Delete: Pi Console *Delete* (type the name) or `iso-project.sh remove <name> --drop-data`.
  A final backup is always written to `/mnt/data/backups/<name>/final-*.dump` first.
