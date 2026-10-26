#!/usr/bin/env bash
# Give Supabase Auth a real mail server, so sign-up confirmations, magic links and
# password resets actually arrive. Free options (no card):
#   Gmail:  host smtp.gmail.com, port 587, user = your Gmail address,
#           password = an App Password (Google account > Security > 2-Step Verification > App passwords)
#   Brevo:  host smtp-relay.brevo.com, port 587, free 300 mails/day
#
#   ./set-smtp.sh                 asks for the settings (password typed hidden)
#   ./set-smtp.sh --test EMAIL    sends a test invite to EMAIL (creates that user; delete it in Studio after)
#
# The password is never printed. .env is backed up first and stays mode 600.
set -euo pipefail
. "$(dirname "$0")/lib-env.sh"
[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE" >&2; exit 1; }

if [ "${1:-}" = "--test" ]; then
  to="${2:?usage: set-smtp.sh --test you@example.com}"
  key="$(get_env SERVICE_ROLE_KEY)"
  code="$(curl -s -o /tmp/smtp-test.$$ -w '%{http_code}' -X POST "http://127.0.0.1:8000/auth/v1/invite" \
    -H "apikey: $key" -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$to\"}")"
  if [ "$code" = 200 ]; then echo "test invite sent to $to (check inbox and spam)"
  else echo "test failed (HTTP $code): $(head -c 300 /tmp/smtp-test.$$)"; echo "auth log:"; docker logs --tail 20 supabase-auth 2>&1 | grep -i -E 'smtp|mail|error' || true; fi
  rm -f /tmp/smtp-test.$$
  exit 0
fi

read -rp  "SMTP host [smtp.gmail.com]: " host;   host="${host:-smtp.gmail.com}"
read -rp  "SMTP port [587]: " port;              port="${port:-587}"
read -rp  "SMTP user (login, e.g. you@gmail.com): " user
read -rsp "SMTP password / app password (hidden): " pass; echo
pass="${pass// /}"   # Gmail shows app passwords with spaces
read -rp  "Sender address [$user]: " from;       from="${from:-$user}"
read -rp  "Sender name [Pi Backend]: " name;     name="${name:-Pi Backend}"
[ -n "$user" ] && [ -n "$pass" ] || { echo "user and password are required" >&2; exit 1; }
case "$pass$name" in *'#'*|*'"'*|*"'"*) echo "please avoid # and quotes in these values" >&2; exit 1;; esac

env_backup
set_env SMTP_HOST "$host"
set_env SMTP_PORT "$port"
set_env SMTP_USER "$user"
set_env SMTP_PASS "$pass"
set_env SMTP_ADMIN_EMAIL "$from"
set_env SMTP_SENDER_NAME "$name"
unset pass
restart_services auth
echo "Auth restarted with the new mail server."
echo "Test it: $0 --test $from"
