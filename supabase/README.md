# Self-hosted Supabase on a Raspberry Pi 5 (4 GB)

This runs the **official Supabase self-host stack** (Postgres, Auth, REST API,
Realtime, Storage, Edge Functions, Studio dashboard) on your Pi. A self-hosted
server never pauses for inactivity, which fixes the problem you had.

Your setup: Pi 5 4 GB, 128 GB SD card, 32 GB pendrive in a USB 3.0 port.

| Where | What lives there |
|---|---|
| SD card | OS, Docker, Postgres data (it is the bigger, faster medium) |
| Pendrive (`/mnt/data`) | Supabase Storage files, nightly database backups |
| RAM + zram | zram compressed swap stretches the 4 GB |

The database and its backups sit on two different cards, so one failing card
does not lose everything.

## Install (about 30-45 min, mostly image downloads)

1. Flash **Raspberry Pi OS Lite (64-bit)**, update it, and copy this folder to the Pi.
2. Plug in the pendrive, find it with `lsblk` (usually `/dev/sda1`). It must be
   **ext4**. If it is FAT/exFAT, the script tells you the exact command to
   format it (that erases the stick), because it never formats anything itself.
3. Run, in order:

```bash
sudo ./00-prepare-pi.sh /dev/sda1      # mount stick, zram, cgroups, Docker (reboot if it asks)
./01-install-supabase.sh               # official install + Pi overrides + start
./02-install-backups.sh                # nightly backup at 03:30, runs one now
```

The dashboard, login and keys are printed at the end of step 2. Open
`http://<pi-ip>:8000` from any device on your network.

Useful afterwards:

```bash
./status.sh                            # temperature, RAM, swap, disks, containers
cd ~/supabase-project && sh run.sh status|logs|restart|secrets
./new-project.sh myapp                 # new schema for a new app (see below)
```

## One instance, many projects

Official self-hosting is **one project per stack**, and a second stack would
need another 2+ GB of RAM, which a 4 GB Pi cannot afford. So each app gets its
own **Postgres schema** inside the one instance:

```bash
./new-project.sh ecommerce
```

```js
createClient(SUPABASE_URL, ANON_KEY, { db: { schema: 'ecommerce' } })
```

Apps share one URL, one set of API keys and one pool of Auth users. Their
tables are separated by schema. Turn on Row Level Security on every table: the
anon key is public. If two apps need fully separate user bases, use a second
instance on another machine.

## Reaching it from Vercel / the internet

A Pi at home is not reachable from the internet by default. The usual free
route is a **Cloudflare Tunnel**: it makes an outbound connection, so there is
no router port-forwarding.

1. Install `cloudflared` on the Pi and create a tunnel to `http://localhost:8000`
   (Cloudflare docs: *Create a locally-managed tunnel*). You need a domain on Cloudflare.
2. Re-run `PUBLIC_URL=https://db.yourdomain.com ./01-install-supabase.sh`, or
   edit `SUPABASE_PUBLIC_URL`, `API_EXTERNAL_URL` and `SITE_URL` in
   `~/supabase-project/.env` and run `sh run.sh recreate`.
3. Use that URL and the anon key in your apps.

Do not publish the dashboard without protection. It already sits behind the
basic-auth login from step 2, but prefer Cloudflare Access (free) on the
dashboard path, and never put the `service_role` / secret key in browser code.

## Honest limits

- **Not 100% the cloud product.** There is no branching, managed backups/PITR,
  or cloud log search; Studio's Logs pages are empty because the log pipeline
  (Logflare/Vector, about 1 GB of RAM) is left out to fit 4 GB.
- **You are the ops team.** Power cuts, home internet, SD-card wear and updates
  are yours. Updating: back up, then `cd ~/supabase-project && sh update.sh && sh run.sh pull && sh run.sh recreate`.
- **Flash wears out.** Use quality A2-rated cards/sticks. Keep the nightly
  backups, and copy `/mnt/data/backups` to your PC or a cloud drive now and
  then. An SSD on the Pi 5's USB port or an NVMe HAT is the upgrade if this
  becomes important.
- **Back up `.env`.** Without its JWT keys a restored database cannot issue
  working tokens. `backup.sh` copies it with each dump.
- **Memory is tight.** Expect roughly 2-2.5 GB used at idle. The limits in
  `docker-compose.pi.yml` are caps; if a service is repeatedly killed, check
  `docker stats` and raise that one.
- **Tested here:** script syntax and the merged compose file against the
  current official files (docker compose config). **Not tested on real Pi
  hardware** (I have no access to it), so run step 1-2 once while watching
  the output.

## Restore a backup

```bash
cd ~/supabase-project
docker exec -i supabase-db pg_restore -h localhost -U supabase_admin -d postgres --clean --if-exists \
  < /mnt/data/backups/db-YYYYMMDD-HHMMSS.dump
```

(Restore into a fresh install using the saved `env-...` file as `.env`.)
