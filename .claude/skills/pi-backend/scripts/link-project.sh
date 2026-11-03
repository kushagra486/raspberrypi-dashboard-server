#!/usr/bin/env bash
# Link the app in the current folder to its project on the Pi. Run it from the app's repo
# after `source connect.sh`:
#
#   link-project.sh NAME                      shared project: schema NAME in the main database
#   link-project.sh NAME --isolated           isolated project: own database, users and keys
#   link-project.sh NAME --site URL           also allow sign-in redirects back to URL
#   link-project.sh NAME --env-file FILE      where to write settings (default .env.local)
#
# Creates the project if it does not exist yet (re-running is safe), then writes the API URL,
# the publishable key and the schema into the env file with the right prefix for the framework
# (NEXT_PUBLIC_ / VITE_ / plain), and makes sure that file is gitignored.
# The project shows up in Pi Console (Database) on its own. Secret keys are never fetched.
set -euo pipefail

die() { printf 'link-project: %s\n' "$*" >&2; exit 1; }

NAME="${1:-}"; shift || true
ISOLATED=0; SITE=""; ENV_FILE=".env.local"
while [ $# -gt 0 ]; do
  case "$1" in
    --isolated) ISOLATED=1 ;;
    --site) SITE="${2:?--site needs a URL}"; shift ;;
    --env-file) ENV_FILE="${2:?--env-file needs a path}"; shift ;;
    *) die "unknown option $1" ;;
  esac
  shift
done

[[ "$NAME" =~ ^[a-z][a-z0-9_]{1,30}$ ]] || die "usage: link-project.sh NAME [--isolated] [--site URL] [--env-file FILE]
NAME: lowercase letters, digits, underscores (2-31 chars), starting with a letter"
[ -z "$SITE" ] || [[ "$SITE" =~ ^https?://[^/]+ ]] || die "--site needs a full URL like https://myapp.vercel.app"
ssh -o BatchMode=yes -o ConnectTimeout=20 pi true 2>/dev/null \
  || die "cannot reach the Pi: run 'source <skill>/scripts/connect.sh' first"

REPO='~/raspberrypi-dashboard-server/supabase'
API_URL="${PI_API_URL:-https://raspberrypi.tailc40262.ts.net}"

if [ "$ISOLATED" = 1 ]; then
  if ssh pi "$REPO/isolated/iso-project.sh keys '$NAME'" >/dev/null 2>&1; then
    echo "isolated project $NAME exists"
  else
    echo "creating isolated project $NAME ..."
    ssh pi "ISO_QUIET_KEYS=1 $REPO/isolated/iso-project.sh create '$NAME'"
  fi
  keys="$(ssh pi "$REPO/isolated/iso-project.sh keys '$NAME'")"
  URL="$(printf '%s\n' "$keys" | sed -n 's/^URL: *//p')"
  KEY="$(printf '%s\n' "$keys" | sed -n 's/^anon (public) key: *//p')"
  SCHEMA=public
  [ -z "$SITE" ] || ssh pi "$REPO/isolated/iso-project.sh site '$NAME' '$SITE'"
else
  exists="$(ssh pi "docker exec supabase-db psql -h localhost -U supabase_admin -d postgres -qAt \
    -c \"select count(*) from pg_namespace where nspname = '$NAME'\"")"
  if [ "$NAME" = public ] || [ "$exists" = 1 ]; then
    echo "shared project $NAME exists"
  else
    echo "creating shared project $NAME ..."
    ssh pi "cd $REPO && ./new-project.sh '$NAME'"
  fi
  URL="$API_URL"
  KEY="$(ssh pi "grep -E '^(SUPABASE_PUBLISHABLE_KEY|ANON_KEY)=' ~/supabase-project/.env | head -1 | cut -d= -f2-")"
  SCHEMA="$NAME"
  [ -z "$SITE" ] || ssh pi "cd $REPO && ./auth-urls.sh add '${SITE%/}/**'"
fi
[ -n "$URL" ] && [ -n "$KEY" ] || die "could not read the project's URL or publishable key"

# Env var prefix the framework exposes to the browser.
PREFIX=""
if [ -f package.json ]; then
  if grep -q '"next"' package.json; then PREFIX=NEXT_PUBLIC_
  elif grep -q '"vite"' package.json; then PREFIX=VITE_
  elif grep -q '"react-scripts"' package.json; then PREFIX=REACT_APP_
  elif grep -q '"expo"' package.json; then PREFIX=EXPO_PUBLIC_
  fi
fi

set_var() {  # KEY VALUE: replace the line if present, else append
  touch "$ENV_FILE"
  if grep -q "^$1=" "$ENV_FILE"; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$1" -v v="$2" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}
set_var "${PREFIX}SUPABASE_URL" "$URL"
set_var "${PREFIX}SUPABASE_PUBLISHABLE_KEY" "$KEY"
set_var "${PREFIX}SUPABASE_SCHEMA" "$SCHEMA"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && ! git check-ignore -q "$ENV_FILE"; then
  printf '\n%s\n' "$ENV_FILE" >> .gitignore
  echo "added $ENV_FILE to .gitignore"
fi

cat <<EOF

Linked to the Pi: $( [ "$ISOLATED" = 1 ] && echo "isolated project $NAME (own users and keys)" || echo "shared project $NAME (schema $NAME)" )
Wrote ${PREFIX}SUPABASE_URL, ${PREFIX}SUPABASE_PUBLISHABLE_KEY, ${PREFIX}SUPABASE_SCHEMA to $ENV_FILE

Client:
  import { createClient } from '@supabase/supabase-js'
  export const supabase = createClient(<${PREFIX}SUPABASE_URL>, <${PREFIX}SUPABASE_PUBLISHABLE_KEY>,
    { db: { schema: '$SCHEMA' } })

Vercel: add the same three variables (Project -> Settings -> Environment Variables).
RLS must be on for every table: the publishable key is public.
Pi Console (Database) lists the project; its Connect page shows these settings too.
EOF
