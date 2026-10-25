#!/usr/bin/env bash
# Where Supabase Auth may send users back to after sign-in, email confirmation,
# magic links and password resets. Every deployed app must be listed.
#
#   ./auth-urls.sh list
#   ./auth-urls.sh site https://myapp.vercel.app        default redirect (SITE_URL)
#   ./auth-urls.sh add  https://myapp.vercel.app/**     allow an extra URL (wildcards ok)
#   ./auth-urls.sh remove https://old.vercel.app/**
set -euo pipefail
. "$(dirname "$0")/lib-env.sh"

cmd="${1:-list}"; url="${2:-}"
urls="$(get_env ADDITIONAL_REDIRECT_URLS)"

need_url() {
  case "$url" in http://*|https://*) ;; *) echo "give a full URL starting with https://" >&2; exit 1;; esac
  case "$url" in *,*|*' '*) echo "one URL at a time, no commas or spaces" >&2; exit 1;; esac
}

case "$cmd" in
  list)
    echo "SITE_URL=$(get_env SITE_URL)"
    echo "ADDITIONAL_REDIRECT_URLS:"; tr ',' '\n' <<<"$urls" | sed '/^$/d;s/^/  /'
    exit 0 ;;
  site)   need_url; env_backup; set_env SITE_URL "$url" ;;
  add)    need_url
          if tr ',' '\n' <<<"$urls" | grep -qxF "$url"; then echo "already listed"; exit 0; fi
          env_backup; set_env ADDITIONAL_REDIRECT_URLS "${urls:+$urls,}$url" ;;
  remove) need_url; env_backup
          set_env ADDITIONAL_REDIRECT_URLS "$(tr ',' '\n' <<<"$urls" | grep -vxF "$url" | sed '/^$/d' | paste -sd, -)" ;;
  *) sed -n 2,9p "$0"; exit 1 ;;
esac
restart_services auth
"$0" list
