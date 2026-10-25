#!/usr/bin/env bash
# Fully isolated projects: each one gets its OWN Postgres database (its own files on disk),
# its OWN sign-up users (Supabase Auth inside that database), its OWN API (PostgREST) and
# its OWN signing secret, so a login from one project is rejected by every other project.
# Served at  https://<pi>/p/<name>/auth/v1  and  https://<pi>/p/<name>/rest/v1  through one
# small proxy that also checks the project's key. The main Supabase stack is not modified,
# except for one-time "lockdown" (see below).
#
#   ./iso-project.sh create NAME            new isolated project (database proj_NAME)
#   ./iso-project.sh list                   projects and container state
#   ./iso-project.sh keys NAME              URL + public (anon) key; --secret also shows the service key
#   ./iso-project.sh site NAME URL          sign-in redirect target (SITE_URL) for that project's app
#   ./iso-project.sh remove NAME --drop-data   stop it, keep a final backup, delete database + roles
#   ./iso-project.sh migrate SCHEMA         copy a SHARED project (schema in the main database) into a new
#                                           isolated project of the same name; the shared copy is kept
#   ./iso-project.sh retire-shared SCHEMA --confirm   after the app has switched: final backup of the shared
#                                           schema, then drop it and remove it from the main API
#   ./iso-project.sh apply                  regenerate proxy/compose from the project folders and (re)start
#   ./iso-project.sh lockdown               only existing logins may connect to the main database
#   ./iso-project.sh funnel                 publish /p on the internet (Tailscale Funnel), once
#
# Secrets live in ISO_DIR/projects/NAME/*.env (mode 600) and are never printed unless asked.
set -euo pipefail

ISO_DIR="${ISO_DIR:-$HOME/supabase-project/isolated}"
MAIN_ENV="${MAIN_ENV:-$HOME/supabase-project/.env}"
NETWORK="${SUPABASE_NETWORK:-supabase_default}"
DB_HOST="${ISO_DB_HOST:-supabase-db}"
PROXY_PORT="${ISO_PROXY_PORT:-8100}"
BACKUP_DIR="${BACKUP_DIR:-/mnt/data/backups}"
AUTH_IMAGE="${ISO_AUTH_IMAGE:-supabase/gotrue:v2.197.0}"
REST_IMAGE="${ISO_REST_IMAGE:-postgrest/postgrest:v14.18}"
PROXY_IMAGE="${ISO_PROXY_IMAGE:-caddy:2.10.2-alpine}"
COMPOSE=(docker compose -p pi-isolated -f "$ISO_DIR/docker-compose.yml")
psql_main() { docker exec -i "$DB_HOST" psql -h localhost -U supabase_admin -v ON_ERROR_STOP=1 -qAt "$@"; }

die() { echo "ERROR: $*" >&2; exit 1; }
need_name() {
  [[ "${1:-}" =~ ^[a-z][a-z0-9_]{1,30}$ ]] || die "name: lowercase letters, digits, underscores; 2-31 chars; starts with a letter"
  case "$1" in postgres|template0|template1|public|auth|storage|realtime|extensions|main) die "'$1' is reserved";; esac
}
main_env() { grep -E "^$1=" "$MAIN_ENV" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
public_host() {
  if [ -n "${ISO_PUBLIC_URL:-}" ]; then echo "$ISO_PUBLIC_URL"; return; fi
  local u; u="$(main_env SUPABASE_PUBLIC_URL)"; echo "${u:-http://127.0.0.1:$PROXY_PORT}"
}
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
jwt() {  # jwt SECRET ROLE  -> HS256 token valid 10 years (like Supabase's anon/service keys)
  local now exp h p s
  now="$(date +%s)"; exp=$((now + 10 * 365 * 24 * 3600))
  h="$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)"
  p="$(printf '{"role":"%s","iss":"supabase","iat":%s,"exp":%s}' "$2" "$now" "$exp" | b64url)"
  s="$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$1" -binary | b64url)"
  printf '%s.%s.%s' "$h" "$p" "$s"
}
pdir() { echo "$ISO_DIR/projects/$1"; }
projects() { [ -d "$ISO_DIR/projects" ] && find "$ISO_DIR/projects" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort || true; }
val() { grep -E "^$2=" "$(pdir "$1")/project.env" | cut -d= -f2-; }

lockdown() {
  # Postgres lets every role CONNECT to a new database by default. Take that away from the
  # main database and give it back explicitly to every login that exists now (except the
  # isolated projects' own roles), so isolated roles can never reach the main data.
  psql_main -d postgres <<'SQL'
do $$
declare r record;
begin
  for r in select rolname from pg_roles where rolcanlogin and rolname not like 'iso\_%' loop
    execute format('grant connect on database postgres to %I', r.rolname);
  end loop;
  revoke connect on database postgres from public;
end $$;
SQL
  echo "main database: CONNECT limited to existing logins (re-run 'lockdown' after a Supabase upgrade adds roles)"
}

write_service_envs() {  # NAME
  local n="$1" d; d="$(pdir "$n")"
  local base; base="$(public_host)/p/$n"
  local site; site="$(val "$n" SITE_URL)"
  umask 077
  cat > "$d/auth.env" <<EOF
GOTRUE_API_HOST=0.0.0.0
GOTRUE_API_PORT=9999
API_EXTERNAL_URL=$base/auth/v1
GOTRUE_DB_DRIVER=postgres
GOTRUE_DB_DATABASE_URL=postgres://iso_${n}_auth:$(val "$n" AUTH_DB_PASSWORD)@$DB_HOST:5432/proj_$n
GOTRUE_DB_DB_NAMESPACE=auth
GOTRUE_SITE_URL=${site:-http://localhost:3000}
GOTRUE_URI_ALLOW_LIST=$(val "$n" REDIRECT_URLS)
GOTRUE_DISABLE_SIGNUP=false
GOTRUE_JWT_ADMIN_ROLES=service_role
GOTRUE_JWT_AUD=authenticated
GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
GOTRUE_JWT_EXP=3600
GOTRUE_JWT_SECRET=$(val "$n" JWT_SECRET)
GOTRUE_EXTERNAL_EMAIL_ENABLED=true
GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=false
GOTRUE_MAILER_AUTOCONFIRM=$(main_env ENABLE_EMAIL_AUTOCONFIRM | grep -qx true && echo true || echo false)
GOTRUE_MAILER_URLPATHS_INVITE=/p/$n/auth/v1/verify
GOTRUE_MAILER_URLPATHS_CONFIRMATION=/p/$n/auth/v1/verify
GOTRUE_MAILER_URLPATHS_RECOVERY=/p/$n/auth/v1/verify
GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE=/p/$n/auth/v1/verify
GOTRUE_EXTERNAL_PHONE_ENABLED=false
EOF
  # mail settings only when the main stack has real ones (empty values crash Auth)
  local k v
  for k in SMTP_ADMIN_EMAIL SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS; do
    v="$(main_env "$k")"
    case "$v" in ''|fake_*|*example.com|supabase-mail) continue;; esac
    echo "GOTRUE_$k=$v" >> "$d/auth.env"
  done
  if grep -q '^GOTRUE_SMTP_HOST=' "$d/auth.env"; then echo "GOTRUE_SMTP_SENDER_NAME=$(val "$n" DISPLAY_NAME)" >> "$d/auth.env"; fi
  cat > "$d/rest.env" <<EOF
PGRST_DB_URI=postgres://iso_${n}_api:$(val "$n" API_DB_PASSWORD)@$DB_HOST:5432/proj_$n
PGRST_DB_SCHEMAS=$(val "$n" API_SCHEMAS | grep . || echo public)
PGRST_JWT_SECRET=$(val "$n" JWT_SECRET)
PGRST_DB_POOL=3
PGRST_DB_USE_LEGACY_GUCS=false
PGRST_DB_CHANNEL_ENABLED=true
PGRST_OPENAPI_MODE=ignore-privileges
EOF
  # no PGRST_DB_ANON_ROLE: a request without this project's key is refused (401)
}

apply() {
  local list p anon svc svcname up
  mkdir -p "$ISO_DIR/projects"; chmod 700 "$ISO_DIR"
  list="$(projects)"
  {
    echo "# Generated by iso-project.sh from $ISO_DIR/projects. Do not edit; run: iso-project.sh apply"
    echo "name: pi-isolated"
    echo "networks: { supabase: { external: true, name: $NETWORK } }"
    echo "services:"
    echo "  proxy:"
    echo "    image: $PROXY_IMAGE"
    echo "    container_name: iso-proxy"
    echo "    restart: unless-stopped"
    echo "    mem_limit: 64m"
    echo "    ports: [\"127.0.0.1:$PROXY_PORT:$PROXY_PORT\"]"
    echo "    volumes: [\"./Caddyfile:/etc/caddy/Caddyfile:ro\"]"
    echo "    logging: { driver: json-file, options: { max-size: \"10m\", max-file: \"3\" } }"
    echo "    networks: [supabase]"
    for p in $list; do
      echo "  auth_$p:"
      echo "    image: $AUTH_IMAGE"
      echo "    container_name: iso-$p-auth"
      echo "    restart: unless-stopped"
      echo "    mem_limit: 64m"
      echo "    env_file: [\"./projects/$p/auth.env\"]"
      echo "    networks: [supabase]"
      echo "  rest_$p:"
      echo "    image: $REST_IMAGE"
      echo "    container_name: iso-$p-rest"
      echo "    restart: unless-stopped"
      echo "    mem_limit: 96m"
      echo "    env_file: [\"./projects/$p/rest.env\"]"
      echo "    networks: [supabase]"
    done
  } > "$ISO_DIR/docker-compose.yml"
  (umask 077
  {
    echo "# Generated by iso-project.sh. Holds project keys: mode 600, do not commit."
    echo "{"; echo "  admin localhost:2019"; echo "  auto_https off"; echo "}"
    echo ":$PROXY_PORT {"
    # access log for Pi Console's per-project request counts: never headers (keys) or query strings (tokens)
    echo "  log {"
    echo "    output stdout"
    echo "    format filter {"
    echo "      wrap json"
    echo "      fields {"
    echo "        request>headers delete"
    echo "        request>tls delete"
    echo "        resp_headers delete"
    echo "        request>uri regexp \\?.* \"\""
    echo "      }"
    echo "    }"
    echo "  }"
    for p in $list; do
      anon="$(val "$p" ANON_KEY)"; svc="$(val "$p" SERVICE_KEY)"
      for svcname in auth rest; do
        [ "$svcname" = auth ] && up="iso-$p-auth:9999" || up="iso-$p-rest:3000"
        echo "  handle_path /p/$p/$svcname/v1/* {"
        echo "    @nokey {"
        echo "      not method OPTIONS"
        echo "      not header apikey $anon"
        echo "      not header apikey $svc"
        echo "    }"
        echo "    respond @nokey \`{\"message\":\"Invalid API key for project $p\"}\` 401"
        echo "    reverse_proxy $up"
        echo "  }"
      done
    done
    echo "  respond \`{\"message\":\"no such project\"}\` 404"
    echo "}"
  } > "$ISO_DIR/Caddyfile")
  (cd "$ISO_DIR" && "${COMPOSE[@]}" up -d --remove-orphans --wait 2>&1 | grep -vE '^\s*$' | tail -20) || true
  docker exec iso-proxy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
    || die "proxy did not accept its config (docker logs iso-proxy)"
}

wait_ready() {  # NAME
  local n="$1" anon a r; anon="$(val "$n" ANON_KEY)"
  for _ in $(seq 1 45); do
    a="$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $anon" "http://127.0.0.1:$PROXY_PORT/p/$n/auth/v1/health" || true)"
    r="$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $anon" -H "Authorization: Bearer $anon" "http://127.0.0.1:$PROXY_PORT/p/$n/rest/v1/" || true)"
    [ "$a" = 200 ] && [ "$r" = 200 ] && return 0
    sleep 2
  done
  die "project $n did not become ready (auth $a, rest $r): docker logs iso-$n-auth / iso-$n-rest"
}

create() {
  local n="$1"; need_name "$n"
  [ -d "$(pdir "$n")" ] && die "project $n already exists"
  [ -n "$(psql_main -d postgres -c "select 1 from pg_database where datname = 'proj_$n'")" ] && die "database proj_$n already exists"
  lockdown >/dev/null
  local d; d="$(pdir "$n")"; mkdir -p "$d"; chmod 700 "$d"
  local secret auth_pw api_pw
  secret="$(openssl rand -hex 32)"; auth_pw="$(openssl rand -hex 24)"; api_pw="$(openssl rand -hex 24)"
  (umask 077; cat > "$d/project.env" <<EOF
NAME=$n
DISPLAY_NAME=${ISO_DISPLAY_NAME:-$n}
DATABASE=proj_$n
JWT_SECRET=$secret
ANON_KEY=$(jwt "$secret" anon)
SERVICE_KEY=$(jwt "$secret" service_role)
AUTH_DB_PASSWORD=$auth_pw
API_DB_PASSWORD=$api_pw
SITE_URL=
REDIRECT_URLS=
API_SCHEMAS=public
CREATED=$(date -Is)
EOF
  )
  # roles + database: only this project's two logins (and the admin) may connect to it
  psql_main -d postgres <<SQL
create role iso_${n}_auth login noinherit password '$auth_pw';
alter role iso_${n}_auth set search_path = auth;
create role iso_${n}_api login noinherit password '$api_pw';
grant anon, authenticated, service_role to iso_${n}_api;
create database proj_$n;
revoke all on database proj_$n from public;
grant connect on database proj_$n to iso_${n}_auth, iso_${n}_api;
SQL
  psql_main -d "proj_$n" <<SQL
revoke create on schema public from public;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on routines to anon, authenticated, service_role;
create schema auth authorization iso_${n}_auth;
grant usage on schema auth to anon, authenticated, service_role;
alter default privileges for role iso_${n}_auth in schema auth grant execute on functions to anon, authenticated, service_role;
SQL
  write_service_envs "$n"
  apply
  wait_ready "$n"
  echo "created isolated project $n (database proj_$n)"
  [ "${ISO_QUIET_KEYS:-}" = 1 ] || keys "$n"
}

keys() {  # NAME [--secret]
  local n="$1"; need_name "$n"; [ -d "$(pdir "$n")" ] || die "no isolated project $n"
  echo "URL:              $(public_host)/p/$n"
  echo "  auth:           $(public_host)/p/$n/auth/v1"
  echo "  rest:           $(public_host)/p/$n/rest/v1"
  echo "anon (public) key: $(val "$n" ANON_KEY)"
  if [ "${2:-}" = "--secret" ]; then echo "service key (SECRET, server-side only): $(val "$n" SERVICE_KEY)"
  else echo "service key: stored in $(pdir "$n")/project.env (show with: keys $n --secret)"; fi
  echo "supabase-js:      createClient('$(public_host)/p/$n', '<anon key>')"
}

set_site() {  # NAME URL
  local n="$1" url="$2"; need_name "$n"; [ -d "$(pdir "$n")" ] || die "no isolated project $n"
  case "$url" in https://*|http://*) ;; *) die "give a full URL";; esac
  local f; f="$(pdir "$n")/project.env"
  sed -i "s|^SITE_URL=.*|SITE_URL=$url|" "$f"
  local cur; cur="$(val "$n" REDIRECT_URLS)"
  case ",$cur," in *",$url/**,"*) ;; *) sed -i "s|^REDIRECT_URLS=.*|REDIRECT_URLS=${cur:+$cur,}$url/**|" "$f";; esac
  write_service_envs "$n"
  (cd "$ISO_DIR" && "${COMPOSE[@]}" up -d --force-recreate --no-deps "auth_$n" >/dev/null 2>&1)
  echo "sign-in redirects for $n: SITE_URL=$url, allowed: $(val "$n" REDIRECT_URLS)"
}

remove() {  # NAME --drop-data
  local n="$1" target; need_name "$n"; target="$n"
  [ "${2:-}" = "--drop-data" ] || die "this deletes project $n's database and users; add --drop-data to confirm"
  [ -d "$(pdir "$n")" ] || die "no isolated project $n"
  mkdir -p "$BACKUP_DIR/$n"
  local final; final="$BACKUP_DIR/$n/final-$(date +%Y%m%d-%H%M%S).dump"
  docker exec "$DB_HOST" pg_dump -h localhost -U supabase_admin -d "proj_$n" -Fc > "$final" \
    || die "final backup failed; nothing removed"
  echo "final backup: $final"
  local trash; trash="$ISO_DIR/removed-$n-$(date +%Y%m%d%H%M%S)"
  mv "$(pdir "$n")" "$trash"
  apply
  [ "$n" = "$target" ] || die "internal error: target changed from $target to $n; nothing dropped"
  [ -d "$(pdir "$target")" ] && die "internal error: $target is still registered; nothing dropped"
  psql_main -d postgres <<SQL
select pg_terminate_backend(pid) from pg_stat_activity where datname = 'proj_$target';
drop database proj_$target;
drop role iso_${target}_auth;
drop role iso_${target}_api;
SQL
  rm -rf "$trash"
  echo "removed isolated project $target (final backup kept at $final)"
}

migrate() {  # SCHEMA: shared project -> new isolated project of the same name
  local sch="$1"; need_name "$sch"
  case "$sch" in *_dev) die "migrate the original project, not a branch";; esac
  [ -d "$(pdir "$sch")" ] && die "an isolated project called $sch already exists"
  [ "$(psql_main -d postgres -c "select count(*) from pg_namespace where nspname = '$sch'")" = 1 ] || die "no shared project (schema) $sch"
  # rows that point at users of the SHARED user pool would lose their users: refuse instead
  local refs
  refs="$(psql_main -d postgres <<SQL
select coalesce(string_agg(format('%s.%s(%s)', cn.nspname, c.relname, a.attname), ', '), '')
from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace cn on cn.oid = c.relnamespace
join pg_class t on t.oid = k.confrelid join pg_namespace tn on tn.oid = t.relnamespace
join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
where k.contype = 'f' and cn.nspname = '$sch' and tn.nspname = 'auth';
SQL
)"
  if [ -n "$refs" ]; then
    local out n_users; out="$(psql_main -d postgres 2>&1 <<SQL
do \$\$ declare r record; total bigint := 0; c bigint;
begin
  for r in select cn.nspname s, c.relname t, a.attname col
    from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace cn on cn.oid = c.relnamespace
    join pg_class tt on tt.oid = k.confrelid join pg_namespace tn on tn.oid = tt.relnamespace
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
    where k.contype = 'f' and cn.nspname = '$sch' and tn.nspname = 'auth'
  loop
    execute format('select count(*) from %I.%I where %I is not null', r.s, r.t, r.col) into c;
    total := total + c;
  end loop;
  raise notice 'USERREFS=%', total;
end \$\$;
SQL
)"
    n_users="$(sed -n 's/.*USERREFS=\([0-9]*\).*/\1/p' <<<"$out")"
    [ "${n_users:-0}" = 0 ] || die "$n_users row(s) in $sch point at users of the shared user pool ($refs). Moving users between pools is not supported yet; nothing was changed."
  fi
  echo "== 1/4 creating isolated project $sch"
  ISO_QUIET_KEYS=1 create "$sch" >/dev/null
  echo "== 2/4 copying schema $sch (structure, data, policies, grants) in one transaction"
  # extensions commonly used by Supabase apps, where they live in Supabase: schema "extensions"
  psql_main -d "proj_$sch" <<SQL
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
SQL
  if ! docker exec "$DB_HOST" pg_dump -h localhost -U supabase_admin -d postgres --schema="$sch" --no-publications --no-subscriptions \
       | docker exec -i "$DB_HOST" psql -h localhost -U supabase_admin -d "proj_$sch" -v ON_ERROR_STOP=1 -q --single-transaction >/dev/null; then
    echo "copy failed: rolling back by removing the new isolated project (the shared project is untouched)" >&2
    ISO_DIR="$ISO_DIR" "$0" remove "$sch" --drop-data >/dev/null 2>&1 || true
    die "migration of $sch failed; nothing changed"
  fi
  echo "== 3/4 verifying row counts"
  local counts_sql="select string_agg(format('%s=%s', c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text), ',' order by c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = '$sch' and c.relkind in ('r','p')"
  local before after
  before="$(psql_main -d postgres -c "$counts_sql")"; after="$(psql_main -d "proj_$sch" -c "$counts_sql")"
  if [ "$before" != "$after" ]; then
    echo "shared:   $before" >&2; echo "isolated: $after" >&2
    die "row counts differ: the isolated copy is kept for inspection; the shared project is untouched"
  fi
  echo "   all tables match: ${before:-no tables}"
  echo "== 4/4 publishing schema $sch through the project's own API"
  local f; f="$(pdir "$sch")/project.env"
  sed -i "s|^API_SCHEMAS=.*|API_SCHEMAS=$sch,public|" "$f"
  grep -q '^MIGRATED_FROM=' "$f" || echo "MIGRATED_FROM=$sch" >> "$f"
  write_service_envs "$sch"
  (cd "$ISO_DIR" && "${COMPOSE[@]}" up -d --force-recreate --no-deps "rest_$sch" >/dev/null 2>&1)
  wait_ready "$sch"
  echo "migrated: $sch now has its own database, users and keys. The shared copy is unchanged."
  echo "next: point the app at the new URL and key (Pi Console > Connect), then: $0 retire-shared $sch --confirm"
}

retire_shared() {  # SCHEMA --confirm
  local sch="$1"; need_name "$sch"
  [ "${2:-}" = "--confirm" ] || die "this drops the SHARED copy of $sch; add --confirm"
  [ "$(val "$sch" MIGRATED_FROM 2>/dev/null)" = "$sch" ] || die "$sch was not migrated to an isolated project; refusing"
  [ "$(psql_main -d postgres -c "select count(*) from pg_namespace where nspname = '$sch'")" = 1 ] || die "no shared schema $sch (already retired?)"
  mkdir -p "$BACKUP_DIR/$sch"
  local final; final="$BACKUP_DIR/$sch/shared-final-$(date +%Y%m%d-%H%M%S).dump"
  docker exec "$DB_HOST" pg_dump -h localhost -U supabase_admin -d postgres --schema="$sch" -Fc > "$final" || die "backup failed; nothing dropped"
  echo "final backup of the shared copy: $final"
  if [ -f "$MAIN_ENV" ]; then
    PROJECT_DIR="$(dirname "$MAIN_ENV")" ENV_FILE="$MAIN_ENV" "$(cd "$(dirname "$0")/.." && pwd)/expose-schema.sh" remove "$sch" \
      || echo "WARNING: could not update the main API for $sch (check PGRST_DB_SCHEMAS in $MAIN_ENV, then restart the rest service)" >&2
  fi
  psql_main -d postgres -c "set client_min_messages = warning" -c "drop schema \"$sch\" cascade" >/dev/null
  echo "shared copy of $sch removed; the isolated project is the only copy now"
}

list() {
  local n
  for n in $(projects); do
    printf '%-24s db=proj_%-20s auth=%-10s rest=%s\n' "$n" "$n" \
      "$(docker inspect -f '{{.State.Status}}' "iso-$n-auth" 2>/dev/null || echo missing)" \
      "$(docker inspect -f '{{.State.Status}}' "iso-$n-rest" 2>/dev/null || echo missing)"
  done
}

funnel() {
  sudo tailscale funnel --bg --set-path=/p "http://127.0.0.1:$PROXY_PORT/p"
  sudo tailscale funnel status
}

cmd="${1:-list}"; shift || true
case "$cmd" in
  create)   create "${1:-}" ;;
  keys)     keys "${1:-}" "${2:-}" ;;
  site)     set_site "${1:-}" "${2:-}" ;;
  remove)   remove "${1:-}" "${2:-}" ;;
  migrate)  migrate "${1:-}" ;;
  retire-shared) retire_shared "${1:-}" "${2:-}" ;;
  list)     list ;;
  apply)    for p in $(projects); do write_service_envs "$p"; done; apply ;;
  lockdown) lockdown ;;
  funnel)   funnel ;;
  *) sed -n 2,23p "$0"; exit 1 ;;
esac
