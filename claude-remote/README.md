# Claude Remote Control on the Pi

Keeps `claude remote-control` running for a project in `~/projects/<repo>`, so its
sessions show up in the Claude app (Code tab) and on claude.ai/code. Starts at boot,
restarts on crash (20 s). Runs as `stdio` in auto permission mode, same-dir spawn.

Installed for: `Sudha-Vatika-` (session "Pi: Sudha-Vatika").

```bash
# one-time per project (folder must be trusted: run `claude` there once and accept)
sudo cp claude-remote@.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now claude-remote@<repo-folder>.service

systemctl status claude-remote@Sudha-Vatika-        # state
journalctl -u claude-remote@Sudha-Vatika- -n 50     # errors (stdout is discarded: the
                                                    # status screen redraws ~6 lines/s)
sudo systemctl disable --now claude-remote@Sudha-Vatika-   # stop for good
```

Memory: ~150 MB idle (peak ~460 MB at start) plus 150-300 MB per active session.
Needs Claude Code signed in with claude.ai on the Pi (`claude auth status`).
