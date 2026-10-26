# shellcheck shell=bash
# Shared helpers for editing ~/supabase-project/.env safely. Source, don't run.
#   set_env KEY VALUE   replace KEY=... (or append it); value passed verbatim, never echoed
#   get_env KEY         print the value of KEY
PROJECT_DIR="${PROJECT_DIR:-$HOME/supabase-project}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"

get_env() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }

set_env() {
  local key="$1" tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  # value travels through the environment, so no quoting/escaping problems and no echo
  KEY="$key" VAL="$2" awk 'BEGIN{k=ENVIRON["KEY"]; v=ENVIRON["VAL"]; done=0}
    index($0, k"=")==1 { if(!done){print k"="v; done=1}; next } {print}
    END{ if(!done) print k"="v }' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

env_backup() {  # one copy per run, mode 600, next to .env
  local b="$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$ENV_FILE" "$b" && chmod 600 "$b" && echo "backup of .env: $b"
}

restart_services() {  # restart only the named services, with the stack's COMPOSE_FILE
  (cd "$PROJECT_DIR" && docker compose up -d --no-deps --force-recreate "$@")
}
