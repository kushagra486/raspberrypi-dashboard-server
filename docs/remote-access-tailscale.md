# Remote access with Tailscale (current setup, no domain needed)

The Pi is on the owner's tailnet as `raspberrypi` (`raspberrypi.tailc40262.ts.net`).
Free Personal plan; no domain, no port forwarding, home IP stays hidden.

| What | Address | Who can reach it |
|---|---|---|
| Pi Console | `http://raspberrypi:7070` | owner's Tailscale devices |
| Supabase Studio | `http://raspberrypi:8000` | owner's Tailscale devices |
| SSH | `ssh stdio@raspberrypi` | owner's Tailscale devices |
| **Supabase API** (`/rest`, `/auth`, `/storage`, `/realtime`, `/functions`, `/graphql` `/v1`) | `https://raspberrypi.tailc40262.ts.net` | **public** via Funnel; needs the app key, RLS applies |

Studio, pg-meta, Pi Console and SSH are **not** on Funnel (verified from the
internet: 404 / unreachable).

## Devices

Install the Tailscale app on laptop/phone and sign in with the same account.
Everything in the table then works from any network.

## Apps (Vercel etc.)

```js
createClient('https://raspberrypi.tailc40262.ts.net', PUBLISHABLE_KEY, { db: { schema: 'myapp' } })
```

Set `SITE_URL` / additional redirect URLs in `~/supabase-project/.env` to the
app's own URL for auth redirects, then `docker compose up -d`.

## Rebuild

1. `sudo tailscale up --hostname=raspberrypi` on the Pi, approve the login.
2. Enable Funnel and HTTPS for the tailnet (admin console; the CLI prints the link).
3. `./tailscale/setup-funnel.sh`

## Limits

- Funnel has bandwidth limits Tailscale does not publish: fine for dev and small
  apps, not for heavy traffic.
- Tailscale clients are open source; the coordination server is not.
- If the Pi or home internet is down, the API is down (Vercel frontends stay up).
- Claude cloud sessions still reach SSH through the temporary
  `quick-tunnel.service` (address via `pi-url`, changes on reboot).
