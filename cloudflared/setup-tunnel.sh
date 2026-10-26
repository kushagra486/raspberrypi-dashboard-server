#!/usr/bin/env bash
# Layer 4: permanent Cloudflare named tunnel for the Pi (run on the Pi, as your user).
#
#   ./cloudflared/setup-tunnel.sh kushagra.dpdns.org
#
# Before running: the domain shows "Active" in Cloudflare, and the Access apps in
# docs/remote-access.md exist (otherwise only the public api.<domain> is published).
# Re-running is safe. The tunnel credentials JSON stays in /etc/cloudflared (root, 600).
set -euo pipefail

DOMAIN="${1:-kushagra.dpdns.org}"
TUNNEL_NAME="${TUNNEL_NAME:-pi}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

log()  { printf '===> %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" != "0" ] || die "run as your normal user (it uses sudo where needed), not root"

log "checking that $DOMAIN is delegated to Cloudflare"
NS="$(curl -fsS -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=$DOMAIN&type=NS" || true)"
echo "$NS" | grep -qi 'ns.cloudflare.com' || die "$DOMAIN does not use Cloudflare nameservers yet. Wait until Cloudflare shows the site as Active."

if ! command -v cloudflared >/dev/null; then
  log "installing cloudflared from Cloudflare's apt repository"
  sudo mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
  sudo apt-get update -y && sudo apt-get install -y cloudflared
fi
cloudflared --version

if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  log "log in to Cloudflare: open the link below on any device and pick $DOMAIN"
  cloudflared tunnel login
fi

tunnel_id() {
  cloudflared tunnel list --name "$TUNNEL_NAME" --output json 2>/dev/null \
    | python3 -c 'import json,sys; t=json.load(sys.stdin) or []; print(t[0]["id"] if t else "")'
}
ID="$(tunnel_id)"
if [ -z "$ID" ]; then
  log "creating tunnel '$TUNNEL_NAME'"
  cloudflared tunnel create "$TUNNEL_NAME"
  ID="$(tunnel_id)"
fi
[ -n "$ID" ] || die "could not find tunnel id"
log "tunnel id: $ID"

log "installing credentials and config into /etc/cloudflared"
sudo mkdir -p /etc/cloudflared
if [ -f "$HOME/.cloudflared/$ID.json" ]; then
  sudo install -m 600 -o root -g root "$HOME/.cloudflared/$ID.json" "/etc/cloudflared/$ID.json"
fi
sudo test -f "/etc/cloudflared/$ID.json" || die "credentials /etc/cloudflared/$ID.json missing"
sed -e "s/\${TUNNEL_ID}/$ID/g" -e "s/\${DOMAIN}/$DOMAIN/g" "$REPO/cloudflared/config.template.yml" \
  | sudo tee /etc/cloudflared/config.yml >/dev/null
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate

log "key-only SSH for tunnel connections"
sudo install -m 644 "$REPO/ssh/10-tunnel-keys-only.conf" /etc/ssh/sshd_config.d/10-tunnel-keys-only.conf
sudo sshd -t && sudo systemctl reload ssh

route() { cloudflared tunnel route dns --overwrite-dns "$ID" "$1.$DOMAIN"; }
log "publishing api.$DOMAIN (public Supabase API)"
route api

read -r -p "Have you created the Cloudflare Access apps for console, studio and ssh (docs/remote-access.md)? [y/N] " ok
if [[ "$ok" =~ ^[Yy]$ ]]; then
  for h in console studio ssh; do log "publishing $h.$DOMAIN (behind Access)"; route "$h"; done
else
  echo "Skipped console/studio/ssh. Create the Access apps, then re-run this script."
fi

if systemctl list-unit-files cloudflared.service >/dev/null 2>&1 && systemctl cat cloudflared >/dev/null 2>&1; then
  log "restarting cloudflared service"
  sudo systemctl restart cloudflared
else
  log "installing cloudflared as a system service (starts at boot)"
  sudo cloudflared --config /etc/cloudflared/config.yml service install
fi

CFG="$REPO/dashboard/config.json"
if [ -f "$CFG" ]; then
  log "allowing https://console.$DOMAIN in Pi Console"
  python3 - "$CFG" "https://console.$DOMAIN" <<'PY'
import json, sys
path, origin = sys.argv[1], sys.argv[2]
cfg = json.load(open(path))
cfg.setdefault("allowedOrigins", [])
if origin not in cfg["allowedOrigins"]:
    cfg["allowedOrigins"].append(origin)
json.dump(cfg, open(path, "w"), indent=2)
PY
  sudo systemctl restart pi-console 2>/dev/null || true
fi

sleep 3
systemctl is-active --quiet cloudflared || { sudo journalctl -u cloudflared -n 30 --no-pager; die "cloudflared is not running"; }
log "done. Tunnel '$TUNNEL_NAME' is up."
echo "Supabase .env (later, when Supabase is installed): SUPABASE_PUBLIC_URL=https://api.$DOMAIN"
echo "  API_EXTERNAL_URL=https://api.$DOMAIN/auth/v1  then: sh run.sh recreate"
