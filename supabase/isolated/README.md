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

## Moving an existing shared project ("Make isolated")

Pi Console → Projects → **Make isolated** on a shared project, or `iso-project.sh migrate <schema>`:

1. creates the isolated project `<schema>` (own database, users, keys);
2. copies the schema (tables, data, keys, indexes, RLS, policies, grants) in **one transaction**;
3. checks every table's row count matches, and stops if not;
4. serves it under the **same schema name**, so the app keeps `db: { schema: '<schema>' }` and only changes
   URL + key (Pi Console → Connect).

The shared copy is **not touched**. Once the app works on the new URL, **Retire shared copy**
(`iso-project.sh retire-shared <schema> --confirm`) writes a final backup to
`/mnt/data/backups/<schema>/shared-final-*.dump`, drops the shared schema and removes it from the main API.

Refused (nothing changed) when rows point at users of the shared user pool: moving users between pools is not
supported yet. Proof: `test-migrate.sh` (19 checks, throw-away schema, cleans up after itself).

## Sleep when idle (auto-sleep)

Each isolated project costs ~45 MB while running. A project in **auto-sleep** is stopped after
`SLEEP_AFTER_MIN` minutes without requests (default 30) and costs 0 MB until the next request, which
starts it again and then succeeds (measured: ready in ~0.6 s, so the first request takes about a second).

- Turn on / off: Pi Console → **Capacity**, or `iso-project.sh sleep-mode <name> auto [minutes]` /
  `iso-project.sh sleep-mode <name> off`. New projects are **always on** until you choose.
- How it wakes: before each request to an auto-sleep project, `iso-proxy` asks Pi Console's **waker**
  (`/wake`, with a secret token from `waker.env`) to make sure the project is up. The waker listens only on
  the Docker network gateway (e.g. `172.18.0.1:7071`): reachable from the proxy, not from the LAN or internet.
  It answers only when Auth `/health` and PostgREST `/ready` (schema cache loaded) both return 200.
- **Memory guard**: if free memory drops under 400 MB (`memoryGuardMb` in Pi Console's `config.json`),
  the least recently used auto-sleep project is put to sleep, one per minute. Always-on projects are never touched.
- Needs Pi Console running. If it is restarting, the proxy retries for up to 20 s; if it is down longer,
  requests to a **sleeping** auto-sleep project fail (502) until it is back. Always-on projects do not depend on it.
- A host firewall must allow the Docker network to reach port 7071 on the host (Pi Console's Capacity page
  says "Waker not listening" if it cannot bind).

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
