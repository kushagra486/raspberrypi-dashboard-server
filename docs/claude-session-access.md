# Claude cloud sessions → Pi (Tailscale SSH)

Any new Claude Code cloud session can reach the Pi over the tailnet, with no
SSH private key to copy and no public tunnel. The session joins as an
**ephemeral** node tagged `tag:claude`; the policy lets that tag reach **only
the Pi, only port 22, only as `stdio`**. Revoke at any time by deleting the auth
key in the Tailscale admin.

## 1. Access policy (Tailscale admin → Access controls)

Replace the policy with this (keeps full access for your own devices, keeps
Funnel working, and boxes in the Claude tag):

```json
{
  "tagOwners": {
    "tag:pi":     ["autogroup:admin"],
    "tag:claude": ["autogroup:admin"]
  },
  "grants": [
    { "src": ["autogroup:member"], "dst": ["*"],      "ip": ["*"] },
    { "src": ["tag:claude"],       "dst": ["tag:pi"], "ip": ["tcp:22"] }
  ],
  "ssh": [
    { "action": "check",  "src": ["autogroup:member"], "dst": ["autogroup:self"], "users": ["autogroup:nonroot", "root"] },
    { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:pi"],         "users": ["stdio"] },
    { "action": "accept", "src": ["tag:claude"],       "dst": ["tag:pi"],         "users": ["stdio"] }
  ],
  "nodeAttrs": [
    { "target": ["autogroup:member", "tag:pi"], "attr": ["funnel"] }
  ]
}
```

Then **Machines → raspberrypi → ⋯ → Edit ACL tags → add `tag:pi`**.
(A tagged device belongs to the tailnet, not a person, and its key does not expire:
right for an always-on server.)

## 2. Auth key (Tailscale admin → Settings → Keys → Generate auth key)

- Reusable: **on** (every new session uses it)
- Ephemeral: **on** (session nodes vanish when the session ends)
- Pre-approved: **on**
- Tags: **`tag:claude`**
- Expiration: 90 days (renew by generating a new one)

Copy the key straight into step 3. Do not paste it into chat.

## 3. Cloud environment (session title bar → environment menu → Edit)

- **Environment variable**: `TS_AUTHKEY` = the key from step 2.
- Network: the Tailscale hosts (`*.tailscale.com`) are already reachable.
- Start a **new session**: running sessions do not see new variables.

## In a session

```bash
source tailscale/claude-connect.sh
ssh pi 'hostname && whoami'
```

## Pi side (done by Claude once steps 1-2 are in place)

`sudo tailscale set --ssh` on the Pi. Your own laptop's `ssh stdio@raspberrypi`
then also goes through Tailscale SSH (policy rule 2: no password, no key).
LAN SSH (`ssh stdio@192.168.1.91`) is unchanged.
