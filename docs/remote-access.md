# Remote access from anywhere (Layer 4)

Permanent addresses for the Pi under `kushagra.dpdns.org`, through a Cloudflare
named tunnel. No port-forwarding; the home IP stays hidden. Works from any
network, as long as the Pi and the home internet are up.

| Address | Goes to | Who gets in |
|---|---|---|
| `console.kushagra.dpdns.org` | Pi Console (dashboard, Claude sessions) | Access: your team's emails |
| `studio.kushagra.dpdns.org` | Supabase Studio | Access: your team's emails |
| `ssh.kushagra.dpdns.org` | SSH (key-only through the tunnel) | Access: your team's emails + a service token for Claude cloud sessions |
| `api.kushagra.dpdns.org` | Supabase API for apps | Public (anon key + RLS) |
| `<app>.kushagra.dpdns.org` | each self-hosted app | Public (add a line in `cloudflared/config.template.yml`) |

Cloudflare Access is free for up to 50 people who log in through it (your team).
App users never count. It needs a card on file in Zero Trust; it is not charged on
the free plan.

## 1. Domain on Cloudflare (once)

1. Cloudflare account (free) at dash.cloudflare.com.
2. Register `kushagra.dpdns.org` at dash.domain.digitalplat.org.
3. Cloudflare → **Add a site** → `kushagra.dpdns.org` → **Free** plan. Copy the two
   nameservers it shows into the DigitalPlat dashboard.
4. Wait until Cloudflare marks the site **Active** (minutes to 24 h).

## 2. Access apps (once, in the browser)

Cloudflare dashboard → **Zero Trust** → pick a team name → choose the **Free** plan
(add the card here) → then **Access → Applications → Add an application →
Self-hosted**, three times:

| Application | Domain | Policy (Allow) |
|---|---|---|
| Pi Console | `console.kushagra.dpdns.org` | Include → Emails → your email (+ team) |
| Supabase Studio | `studio.kushagra.dpdns.org` | Include → Emails → your email (+ team) |
| Pi SSH | `ssh.kushagra.dpdns.org` | Include → Emails → your email; **plus** a second policy, action **Service Auth**, Include → Service Token → `claude-sessions` |

Login method: the default **One-time PIN** (code sent to your email) is enough.

For Claude cloud sessions: **Access → Service Auth → Service Tokens → Create**
named `claude-sessions`. Copy the Client ID and Secret once; store them only as
environment secrets (step 5), never in git or chat.

## 3. Tunnel on the Pi

```bash
cd ~/raspberrypi-dashboard-server
./cloudflared/setup-tunnel.sh kushagra.dpdns.org
```

It installs `cloudflared`, has you log in once (opens a link), creates the tunnel
`pi`, writes `/etc/cloudflared/config.yml`, publishes the addresses, turns on
key-only SSH for tunnel connections, and installs a service that starts at boot.
It only publishes console/studio/ssh after you confirm step 2 is done.

## 4. Your laptop (Windows)

Browser: open `https://console.kushagra.dpdns.org`, enter the email code, then the
Pi Console password. Nothing to install.

SSH from anywhere: install cloudflared once (`winget install Cloudflare.cloudflared`),
then add to `C:\Users\kusha\.ssh\config`:

```
Host pi
  HostName ssh.kushagra.dpdns.org
  User stdio
  ProxyCommand "C:\Program Files (x86)\cloudflared\cloudflared.exe" access ssh --hostname %h
```

`ssh pi` now works on any network (first time: a browser window for the email code).
Tunnel SSH is key-only, so add your laptop key to the Pi first:
`type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh stdio@192.168.1.91 "cat >> ~/.ssh/authorized_keys"` (at home).

## 5. Claude cloud sessions

In the cloud environment's settings:
- **Network access**: allow `ssh.kushagra.dpdns.org` (and `console.kushagra.dpdns.org`).
- **Secrets**: `PI_SSH_KEY` (a dedicated private key whose public half is in the
  Pi's `authorized_keys`), `TUNNEL_SERVICE_TOKEN_ID`, `TUNNEL_SERVICE_TOKEN_SECRET`.

A session then connects with:

```bash
ssh -i ~/.ssh/pi_agent -o ProxyCommand="cloudflared access ssh --hostname %h" stdio@ssh.kushagra.dpdns.org
```

(`cloudflared` reads the service token from those two environment variables.)
Revoke at any time: delete the service token in Zero Trust, or remove the key line
from `~/.ssh/authorized_keys` on the Pi.
