# Owner to-do (Kushagra)

Things only the owner can do. Claude sessions: remind him of open items when
relevant, never do them for him, and tick them off here once he confirms.

## Open

- [ ] **Save passwords in a password manager** (done 2026-10-25) (Bitwarden or KeePassXC), then delete
      `~/pi-console-password.txt` on the Pi. Steps:
  1. `ssh stdio@raspberrypi`
  2. Pi Console: `cat ~/pi-console-password.txt` → save as "Pi Console",
     URL `http://raspberrypi:7070` → test the login → `rm ~/pi-console-password.txt`
  3. Supabase: `cd ~/supabase-project && sh run.sh secrets` and
     `grep DASHBOARD_USERNAME .env` → save as "Supabase (Pi)" with the API URL
     `https://raspberrypi.tailc40262.ts.net`. Only the publishable key may go in apps.
  4. Off-Pi copy of `.env`: `scp stdio@raspberrypi:supabase-project/.env $HOME\Documents\pi-supabase.env`
     → attach (KeePassXC) or paste into a secure note (Bitwarden) → delete the laptop copy.
- [ ] **Disable the Pi's Tailscale key expiry**: login.tailscale.com/admin/machines →
      raspberrypi → ⋯ → Disable key expiry (otherwise it drops off on 2027-04-22).
- [ ] **Official Raspberry Pi 27 W USB-C power supply**: the Pi reports under-voltage at
      every boot (`vcgencmd get_throttled` = `0x50000`).
- [ ] **Tailscale app on laptop and phone**, signed in as darkbar4@gmail.com, so
      `raspberrypi:7070`, `raspberrypi:8000` and `ssh stdio@raspberrypi` work anywhere.
- [ ] **Renew the Claude auth key** before it expires (90 days from 2026-10-24, so by
      ~2027-01-22): Tailscale admin → Settings → Keys → new reusable, ephemeral,
      pre-approved key tagged `tag:claude` → replace `TS_AUTHKEY` in the cloud environment.

## Done

- [x] Decision 2026-10-25: **no secret rotation** after the `.env` was pasted into a private Claude chat (owner accepts the risk; no apps use the keys yet). Revisit only if he asks.

- [x] Pendrive formatted ext4 at `/mnt/data` (2026-10-24)
- [x] Tailscale login, Funnel enabled, access policy applied, Pi tagged `tag:pi` (2026-10-24)
- [x] `TS_AUTHKEY` stored in the cloud environment; Claude session access verified (2026-10-24)
- [x] Decision: no domain, no Cloudflare (2026-10-24)
- [x] Bitwarden set up; Pi Console password reset with `npm run set-password` and saved;
      `~/pi-console-password.txt` gone; `.env` saved as two secure notes (2026-10-25)
