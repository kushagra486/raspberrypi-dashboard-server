# This machine: Kushagra's Raspberry Pi 5 (always-on dev backend)

Infra repo and full status: ~/raspberrypi-dashboard-server (read its CLAUDE.md before changing the Pi itself).

## GitHub on this Pi
- Signed in to GitHub (`gh`) as kushagra486 with read/write to all his repos.
- Don't clone repos by hand into random places. Use:
  - `repo list [word]` to find a repo, `repo open NAME` for a slim clone in ~/projects/NAME (prints the path),
  - `repo new NAME [--public]` to create one (private by default), `repo status` to see local copies.
- Push your work to GitHub. A weekly `repo prune` (Sun 04:45) removes copies untouched for 14 days
  that are fully pushed; uncommitted, unpushed, stashed or in-use copies are always kept.
- Details: ~/raspberrypi-dashboard-server/github/README.md

## Rules here
- Never print or commit secrets (Supabase .env, keys, tokens). The Pi has 4 GB RAM: keep it light.
- Ask before destructive or hard-to-undo actions (dropping data, deleting backups, reboots).
