# Off-site copy of the Pi's database backups onto this Windows laptop, over Tailscale.
# No cloud account, no API. Runs daily via Task Scheduler (see docs/ROADMAP.md, A6),
# and catches up when the laptop was off.
#
# Copies only the database dumps (db-*.dump): the .env secrets are already in Bitwarden.
# Keeps the newest 30 days in Documents\PiBackups. Needs: Tailscale on, `ssh stdio@raspberrypi`
# working without a password prompt (Tailscale SSH or an SSH key).

$ErrorActionPreference = 'Stop'
$Pi   = 'stdio@raspberrypi'
$Dest = Join-Path $env:USERPROFILE 'Documents\PiBackups'
$Log  = Join-Path $Dest 'pull.log'
$Ssh  = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20')
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

function Log($m) { "$(Get-Date -Format s)  $m" | Tee-Object -FilePath $Log -Append }

try {
  $remote = & ssh @Ssh $Pi 'ls -1t /mnt/data/backups/db-*.dump 2>/dev/null | head -7'
  if ($LASTEXITCODE -ne 0 -or -not $remote) { throw "cannot list backups on the Pi (is Tailscale on?)" }
  $new = 0
  foreach ($f in $remote) {
    $name = Split-Path $f -Leaf
    if (-not (Test-Path (Join-Path $Dest $name))) {
      & scp @Ssh "${Pi}:$f" "$Dest\" ; if ($LASTEXITCODE -ne 0) { throw "copy failed: $name" }
      $new++
    }
  }
  Get-ChildItem $Dest -Filter 'db-*.dump' | Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) | Remove-Item
  # tell the Pi's health check that an off-site copy exists
  & ssh @Ssh $Pi 'date -Is > /mnt/data/backups/.offsite-ok' | Out-Null
  Log "ok: $new new, $((Get-ChildItem $Dest -Filter 'db-*.dump').Count) kept in $Dest"
} catch {
  Log "FAILED: $_"
  exit 1
}
