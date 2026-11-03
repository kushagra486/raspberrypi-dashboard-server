# GitHub on the Pi

The Pi is signed in to GitHub as `kushagra486` with `gh` (GitHub CLI device login,
2026-10-27; scopes `repo`, `workflow`, `read:org`, `gist`, no `delete_repo`). Git over HTTPS
uses it through `gh auth git-credential`. The token is in a password-less GNOME keyring
(`~/.local/share/keyrings`, mode 600), which opens at boot because `stdio` lingers.
Revoke: github.com → Settings → Applications → Authorized OAuth Apps → GitHub CLI.

`repo` (symlinked to `~/.local/bin/repo`) keeps GitHub the source of truth: copies live in
`~/projects` only while in use, as blobless clones, and `repo prune` (weekly cron, Sunday 04:45, log `~/.cache/repo-prune.log`)
removes copies untouched for 14 days that have nothing uncommitted, unpushed or stashed and
are not used by a remote-control service or tmux session.

```bash
repo list [word]      repo open NAME      repo new NAME [--public]
repo status           repo close NAME     repo prune [DAYS]
```

`pi-claude-user-CLAUDE.md` is the copy of `~/.claude/CLAUDE.md` on the Pi: every Claude
session there (remote control, Pi Console) reads it, so they use `repo` instead of ad-hoc clones.
