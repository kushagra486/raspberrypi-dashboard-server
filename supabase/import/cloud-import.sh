#!/usr/bin/env bash
# Import a Supabase CLOUD project onto the Pi. The cloud project is only READ, never changed.
#
#   ./cloud-import.sh add ALIAS        paste the project's connection string (hidden input); stored on the Pi
#                                      only, in ~/.config/pi-import/ALIAS.url (mode 600). Run this yourself.
#   ./cloud-import.sh inspect ALIAS    what is in it (schemas, tables, rows, users, storage, realtime,
#                                      extensions, triggers) and where it should go on the Pi
#   ./cloud-import.sh run ALIAS --as isolated|shared [--name NAME] [--schemas public,...]
#                                      [--without-storage] [--without-realtime]
#        isolated: new isolated project NAME (own database, users and keys); tables, data, RLS, policies,
#                  functions, triggers AND the sign-up users (passwords keep working) are copied
#        shared:   one schema, renamed to NAME, in the main database (no users copied; refused when rows
#                  point at the cloud project's users: use isolated)
#   ./cloud-import.sh list             stored aliases (never the connection strings)
#   ./cloud-import.sh forget ALIAS     delete a stored connection string (do this after importing)
#
# Connection string: Supabase dashboard > Connect > "Session pooler" (port 5432, IPv4).
# Not the direct one (IPv6 only) and not the transaction pooler (port 6543, breaks pg_dump).
# The password never appears in process lists, logs or output: it travels to pg_dump through stdin.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISO="${ISO_SCRIPT:-$HERE/../isolated/iso-project.sh}"
EXPOSE="${EXPOSE_SCRIPT:-$HERE/../expose-schema.sh}"
CONF="${PI_IMPORT_DIR:-$HOME/.config/pi-import}"
DB_HOST="${ISO_DB_HOST:-supabase-db}"
WORK="${PI_IMPORT_WORK:-/mnt/data/import-tmp}"

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo "$*"; }
need_alias() { [[ "${1:-}" =~ ^[a-z][a-z0-9_-]{0,39}$ ]] || die "alias: lowercase letters, digits, - or _"; }
url_file() { echo "$CONF/$1.url"; }
psql_local() { docker exec -i "$DB_HOST" psql -h localhost -U supabase_admin -v ON_ERROR_STOP=1 -qAt "$@"; }

# libpq settings from the stored URL, one per line, then a blank line. Never printed to the terminal.
src_env() {
  python3 - "$(url_file "$1")" <<'PY'
import sys, urllib.parse as u
s = open(sys.argv[1]).read().strip()
p = u.urlsplit(s)
if p.scheme not in ('postgres', 'postgresql') or not p.hostname: sys.exit('not a postgres:// connection string')
q = dict(u.parse_qsl(p.query))
for k, v in (('PGHOST', p.hostname), ('PGPORT', str(p.port or 5432)), ('PGUSER', u.unquote(p.username or 'postgres')),
             ('PGPASSWORD', u.unquote(p.password or '')), ('PGDATABASE', u.unquote(p.path.lstrip('/')) or 'postgres'),
             ('PGSSLMODE', q.get('sslmode', 'require')), ('PGCONNECT_TIMEOUT', '20'), ('PGAPPNAME', 'pi-import')):
    if '\n' in v: sys.exit('bad connection string')
    print(f'{k}={v}')
print()
PY
}
# run a client program inside the database container against the CLOUD project.
# stdin after the settings block is passed on (SQL for psql).
src() {  # ALIAS PROGRAM ARGS...   (reads extra stdin)
  local a="$1"; shift
  { src_env "$a"; cat; } | docker exec -i "$DB_HOST" sh -c \
    'while IFS= read -r l; do [ -z "$l" ] && break; export "$l"; done; exec "$@"' sh "$@"
}
src_sql() { src "$1" psql -X -v ON_ERROR_STOP=1 -qAt -F '|'; }  # SQL on stdin

INTERNAL_SCHEMAS="'pg_catalog','information_schema','auth','storage','realtime','_realtime','extensions','graphql','graphql_public','vault','pgsodium','pgsodium_masks','net','supabase_functions','supabase_migrations','cron','_analytics','pgbouncer','pgtle','topology','tiger','tiger_data','_supavisor','pg_temp','pg_toast'"
INTERNAL_EXT="'plpgsql','pg_graphql','pg_stat_statements','supabase_vault','pgsodium','pg_net','pgjwt','pg_cron','pg_tle','plpgsql_check','supautils','index_advisor','hypopg','wrappers','pgaudit'"

# ---------------------------------------------------------------- facts about the cloud project
facts() {  # ALIAS SCHEMAS(comma or empty=all app schemas) -> KEY|value lines
  local sl="${2:-}" filter
  if [ -n "$sl" ]; then filter="n.nspname = any(string_to_array('$sl', ','))"
  else filter="n.nspname not in ($INTERNAL_SCHEMAS) and n.nspname not like 'pg\\_%'"; fi
  src_sql "$1" <<SQL
select 'VERSION|' || current_setting('server_version');
select 'SIZE|' || pg_database_size(current_database());
select 'SCHEMA|' || n.nspname || '|' || count(c.oid) filter (where c.relkind in ('r','p')) || '|' ||
       coalesce(sum(c.reltuples) filter (where c.relkind in ('r','p') and c.reltuples > 0), 0)::bigint || '|' ||
       coalesce(sum(pg_total_relation_size(c.oid)) filter (where c.relkind in ('r','p')), 0)
  from pg_namespace n left join pg_class c on c.relnamespace = n.oid
 where $filter group by n.nspname order by n.nspname;
select 'USERS|' || case when to_regclass('auth.users') is null then 0 else (xpath('/row/n/text()', query_to_xml('select count(*) as n from auth.users', false, true, '')))[1]::text::bigint end;
select 'IDENTITIES|' || x from unnest(xpath('//x/text()', ('<r>' || case when to_regclass('auth.identities') is null then '' else query_to_xml('select provider || ''|'' || count(*) as x from auth.identities group by provider', true, false, '')::text end || '</r>')::xml)) as t(x);
select 'MFA|' || case when to_regclass('auth.mfa_factors') is null then 0 else (xpath('/row/n/text()', query_to_xml('select count(*) as n from auth.mfa_factors', false, true, '')))[1]::text::bigint end;
select 'USERFK|' || cn.nspname || '.' || c.relname || '|' || a.attname
  from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace cn on cn.oid = c.relnamespace
  join pg_class t on t.oid = k.confrelid join pg_namespace tn on tn.oid = t.relnamespace
  join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
 where k.contype = 'f' and tn.nspname = 'auth' and t.relname = 'users' and cn.nspname not in ($INTERNAL_SCHEMAS)
   and (cn.nspname = any(string_to_array('$sl', ',')) or '$sl' = '');
select 'AUTHTRIGGER|' || t.tgname || '|' || p.pronamespace::regnamespace || '.' || p.proname
  from pg_trigger t join pg_proc p on p.oid = t.tgfoid
 where t.tgrelid = to_regclass('auth.users') and not t.tgisinternal;
select 'STORAGE|' || case when to_regclass('storage.buckets') is null then 0 else (xpath('/row/n/text()', query_to_xml('select count(*) as n from storage.buckets', false, true, '')))[1]::text::bigint end || '|' || case when to_regclass('storage.objects') is null then 0 else (xpath('/row/n/text()', query_to_xml('select count(*) as n from storage.objects', false, true, '')))[1]::text::bigint end || '|' || case when to_regclass('storage.objects') is null then 0 else (xpath('/row/n/text()', query_to_xml('select coalesce(sum((metadata->>''size'')::bigint), 0) as n from storage.objects', false, true, '')))[1]::text::bigint end;
select 'REALTIME|' || count(*) from pg_publication_tables where pubname = 'supabase_realtime'
   and schemaname not in ($INTERNAL_SCHEMAS);
select 'EXT|' || e.extname || '|' || e.extnamespace::regnamespace from pg_extension e where e.extname not in ($INTERNAL_EXT);
select 'CRON|' || case when to_regclass('cron.job') is null then 0 else (xpath('/row/n/text()', query_to_xml('select count(*) as n from cron.job', false, true, '')))[1]::text::bigint end;
SQL
}
fval() { grep -E "^$1\|" <<<"$FACTS" | head -1 | cut -d'|' -f2-; }
fall() { grep -E "^$1\|" <<<"$FACTS" | cut -d'|' -f2- || true; }

# exact row counts per table, "table=count" sorted
count_sql() {  # SCHEMAS(comma)
  echo "select coalesce(string_agg(format('%s.%s=%s', n.nspname, c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text), ',' order by n.nspname, c.relname), '')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = any(string_to_array('$1', ',')) and c.relkind in ('r','p');"
}

# cleanup state (globals, so the EXIT trap still sees them after a function returns)
DUMP=""; TMPDB=""; UNDO_PROJECT=""
cleanup() {
  local rc=$?
  [ -n "$DUMP" ] && rm -f "$DUMP" "$DUMP.raw"
  [ -n "$TMPDB" ] && psql_local -d postgres -c "drop database if exists $TMPDB with (force)" >/dev/null 2>&1
  if [ "$rc" != 0 ] && [ -n "$UNDO_PROJECT" ]; then
    echo "import failed: removing the half-made project $UNDO_PROJECT (the cloud project is untouched)" >&2
    "$ISO" remove "$UNDO_PROJECT" --drop-data >/dev/null 2>&1 || true
  fi
  return "$rc"
}
trap cleanup EXIT

human() { numfmt --to=iec --suffix=B "${1:-0}" 2>/dev/null || echo "${1:-0} B"; }

# ---------------------------------------------------------------- commands
add() {
  local a="$1"; need_alias "$a"
  [ -t 0 ] || die "run this yourself in a terminal (Pi Console > Terminal): the connection string is typed hidden"
  mkdir -p "$CONF"; chmod 700 "$CONF"
  local u
  echo "Supabase dashboard > your project > Connect > Session pooler. Copy the URI, put your database password in it."
  read -rsp "Paste the connection string (hidden): " u; echo
  case "$u" in postgres://*|postgresql://*) ;; *) die "that is not a postgresql:// connection string; nothing saved";; esac
  case "$u" in *:6543/*) die "that is the transaction pooler (port 6543); use the Session pooler (port 5432)";; esac
  case "$u" in *'[YOUR-PASSWORD]'*|*'[YOUR_PASSWORD]'*) die "replace [YOUR-PASSWORD] with the database password first";; esac
  (umask 077; printf '%s\n' "$u" > "$(url_file "$a")")
  unset u
  if out="$(echo 'select current_setting($$server_version$$)' | src_sql "$a" 2>&1)"; then
    say "saved as '$a' (Postgres $out). Next: $0 inspect $a"
  else
    rm -f "$(url_file "$a")"
    die "could not connect, nothing saved: $(sed 's/password=[^ ]*/password=***/g' <<<"$out" | tail -2)"
  fi
}

inspect() {
  local a="$1"; need_alias "$a"; [ -f "$(url_file "$a")" ] || die "no stored connection '$a' (add it first)"
  FACTS="$(facts "$a" "")"
  local users objects bytes realtime fk
  users="$(fval USERS)"; IFS='|' read -r _ objects bytes <<<"$(fval STORAGE)"; realtime="$(fval REALTIME)"
  say "== $a: Postgres $(fval VERSION), database $(human "$(fval SIZE)")"
  say "-- app schemas (tables, ~rows, size)"
  while IFS='|' read -r s t r b; do [ -z "$s" ] || printf '   %-24s %4s tables  ~%-9s %s\n' "$s" "$t" "$r" "$(human "$b")"; done <<<"$(fall SCHEMA)"
  say "-- sign-up users: $users$( [ "$(fval MFA)" != 0 ] && echo " ($(fval MFA) MFA factors: not copied, those users set MFA up again)")"
  while IFS='|' read -r p c; do if [ -n "$p" ]; then say "   login via $p: $c"; fi; done <<<"$(fall IDENTITIES)"
  fk="$(fall USERFK | tr '|' '.' | paste -sd, -)"
  if [ -n "$fk" ]; then say "   tables pointing at users: $fk"; fi
  local trig; trig="$(fall AUTHTRIGGER | sed 's/|\(.*\)/ (\1)/' | paste -sd, -)"
  if [ -n "$trig" ]; then say "   triggers on new users (copied for isolated): $trig"; fi
  say "-- file storage: $objects files, $(human "$bytes") in $(fval STORAGE | cut -d'|' -f1) buckets"
  say "-- realtime tables: $realtime"
  local ext; ext="$(fall EXT | tr '|' '@' | paste -sd' ' -)"; say "-- extensions: ${ext:-none}"
  [ "$(fval CRON)" = 0 ] || say "-- scheduled jobs (pg_cron): $(fval CRON): NOT copied, recreate them by hand"
  say "-- edge functions: cannot be seen from the database; check the dashboard (they are not imported)"
  say ""
  # same rules as Pi Console's placement advisor
  if [ "$users" = 0 ]; then   # no sign-up users: nothing to keep separate
    say "RECOMMENDED: shared   ->  $0 run $a --as shared --name <name>"
    if [ "$objects" != 0 ]; then say "   (storage files are not copied yet: add --without-storage and copy files separately)"; fi
  elif [ "$objects" != 0 ] || [ "$realtime" != 0 ]; then
    say "RECOMMENDED: stay on cloud for now: it has its own users AND $( [ "$objects" != 0 ] && echo 'file storage')$( [ "$objects" != 0 ] && [ "$realtime" != 0 ] && echo ' and ')$( [ "$realtime" != 0 ] && echo realtime), which isolated projects do not have yet."
    say "   (to import the database and users anyway: --as isolated --without-storage --without-realtime)"
  else
    say "RECOMMENDED: isolated ->  $0 run $a --as isolated --name <name>"
  fi
}

ensure_extensions() {  # DB  (from FACTS: EXT lines)
  local db="$1" e s
  while IFS='|' read -r e s; do
    [ -n "$e" ] || continue
    if ! psql_local -d "$db" -c "create schema if not exists \"$s\"; create extension if not exists \"$e\" with schema \"$s\"" >/dev/null 2>&1; then
      die "extension $e is not available on the Pi; nothing imported"
    fi
  done <<<"$(fall EXT)"
  psql_local -d "$db" -c "grant usage on schema extensions to anon, authenticated, service_role" >/dev/null 2>&1 || true
}

# plain SQL dump of the cloud schemas, minus grants to roles the Pi does not have
cloud_dump() {  # ALIAS SCHEMAS OUTFILE
  local args=() s roles
  IFS=',' read -ra ss <<<"$2"; for s in "${ss[@]}"; do args+=(--schema="$s"); done
  src "$1" pg_dump --no-owner --no-publications --no-subscriptions --no-comments "${args[@]}" </dev/null > "$3.raw" \
    || die "pg_dump from the cloud failed; nothing imported"
  roles="$(psql_local -d postgres -c "select string_agg(rolname, ' ') from pg_roles")"
  ROLES=" $roles " awk '
    function known(r) { gsub(/[";]/, "", r); return index(ENVIRON["ROLES"], " " r " ") > 0 }
    /^(GRANT|REVOKE) / && / (TO|FROM) / {
      line = $0; sub(/.* (TO|FROM) /, "", line); sub(/( WITH GRANT OPTION)?;$/, "", line); sub(/ GRANTED BY .*/, "", line)
      n = split(line, rs, /, */); for (i = 1; i <= n; i++) if (rs[i] != "PUBLIC" && !known(rs[i])) next
    }
    /^ALTER DEFAULT PRIVILEGES FOR ROLE / { r = $5; if (!known(r)) next }
    /^SET transaction_timeout/ { next }
    /^CREATE SCHEMA public;$/ { next }
    { print }' "$3.raw" > "$3"
  rm -f "$3.raw"
}

copy_auth_table() {  # ALIAS DB TABLE
  local cols
  cols="$(psql_local -d "$2" -c "select string_agg(quote_ident(attname), ',' order by attnum) from pg_attribute
           where attrelid = 'auth.$3'::regclass and attnum > 0 and not attisdropped and attgenerated = ''")"
  local cloud_cols
  cloud_cols="$(echo "select string_agg(attname, ',') from pg_attribute where attrelid = 'auth.$3'::regclass and attnum > 0 and not attisdropped" | src_sql "$1")"
  local common; common="$(tr ',' '\n' <<<"$cols" | tr -d '"' | grep -Fxf <(tr ',' '\n' <<<"$cloud_cols") | sed 's/.*/"&"/' | paste -sd, -)"
  [ -n "$common" ] || die "auth.$3: no common columns"
  echo "copy (select $common from auth.$3) to stdout" | src "$1" psql -X -v ON_ERROR_STOP=1 -q \
    | psql_local -d "$2" -c "copy auth.$3 ($common) from stdin" >/dev/null
}

run() {
  local a="$1"; shift; need_alias "$a"; [ -f "$(url_file "$a")" ] || die "no stored connection '$a'"
  local as="" name="" schemas="" no_storage=0 no_rt=0
  while [ $# -gt 0 ]; do case "$1" in
    --as) as="${2:-}"; shift 2 ;; --name) name="${2:-}"; shift 2 ;; --schemas) schemas="${2:-}"; shift 2 ;;
    --without-storage) no_storage=1; shift ;; --without-realtime) no_rt=1; shift ;;
    *) die "unknown option $1" ;; esac; done
  [ "$as" = isolated ] || [ "$as" = shared ] || die "--as isolated or --as shared"
  name="${name:-${a//-/_}}"
  [[ "$name" =~ ^[a-z][a-z0-9_]{1,30}$ ]] || die "--name: lowercase letters, digits, _ (2-31 chars)"
  FACTS="$(facts "$a" "$schemas")"
  [ -n "$schemas" ] || schemas="$(fall SCHEMA | cut -d'|' -f1 | paste -sd, -)"
  [ -n "$schemas" ] || die "no app schemas found in the cloud project"
  local users objects realtime fk
  users="$(fval USERS)"; objects="$(fval STORAGE | cut -d'|' -f2)"; realtime="$(fval REALTIME)"
  fk="$(fall USERFK | tr '|' '.' | paste -sd, -)"
  [ "$objects" = 0 ] || [ "$no_storage" = 1 ] || die "it has $objects storage files, which are not copied; add --without-storage to import without them"
  if [ "$as" = isolated ]; then [ "$realtime" = 0 ] || [ "$no_rt" = 1 ] || die "it uses realtime on $realtime table(s), which isolated projects lack; add --without-realtime"; fi
  # room on the Pi: the copy needs about twice its size free
  local size free; size="$(fval SIZE)"; free="$(df -B1 --output=avail "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /)" | tail -1)"
  [ "$((size * 2))" -lt "$free" ] || die "not enough disk space: cloud database $(human "$size"), free $(human "$free")"
  mkdir -p "$WORK"; chmod 700 "$WORK"
  local dump; dump="$WORK/$name-$(date +%s).sql"; DUMP="$dump"
  say "== reading row counts in the cloud"
  local before; before="$(count_sql "$schemas" | src_sql "$a")"
  if [ "$as" = isolated ]; then run_isolated "$a" "$name" "$schemas" "$dump" "$before" "$users"
  else run_shared "$a" "$name" "$schemas" "$dump" "$before" "$fk"; fi
}

run_isolated() {
  local a="$1" name="$2" schemas="$3" dump="$4" before="$5" users="$6" db="proj_$2"
  say "== 1/6 creating isolated project $name"
  ISO_QUIET_KEYS=1 ISO_DISPLAY_NAME="$name" "$ISO" create "$name" >/dev/null
  UNDO_PROJECT="$name"
  say "== 2/6 extensions"
  ensure_extensions "$db"
  say "== 3/6 copying $users sign-up users (password hashes included, so passwords keep working)"
  copy_auth_table "$a" "$db" users
  copy_auth_table "$a" "$db" identities
  say "== 4/6 copying schemas $schemas (structure, data, RLS, policies, functions) in one transaction"
  cloud_dump "$a" "$schemas" "$dump"
  docker exec -i "$DB_HOST" psql -h localhost -U supabase_admin -d "$db" -v ON_ERROR_STOP=1 -q --single-transaction \
    -c "set session_replication_role = replica" -f - < "$dump" >/dev/null || die "restore failed"
  say "== 5/6 triggers on new users"
  local t
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    psql_local -d "$db" -c "$t" >/dev/null || die "could not recreate trigger: $t"
    say "   $t"
  done <<<"$(echo "set search_path = ''; select pg_get_triggerdef(oid) from pg_trigger where tgrelid = to_regclass('auth.users') and not tgisinternal" | src_sql "$a")"
  say "== 6/6 verifying"
  local after lu; after="$(psql_local -d "$db" -c "$(count_sql "$schemas")")"; lu="$(psql_local -d "$db" -c "select count(*) from auth.users")"
  [ "$lu" = "$users" ] || die "users: cloud $users, Pi $lu"
  if [ "$before" != "$after" ]; then
    echo "cloud: $before" >&2; echo "Pi:    $after" >&2
    die "row counts differ (was the app writing during the copy? run again in a quiet moment)"
  fi
  "$ISO" schemas "$name" "$schemas" >/dev/null
  UNDO_PROJECT=""
  say "   users $lu = $lu; tables: ${after:-none}"
  say ""
  say "imported '$a' as isolated project $name. The cloud project was not changed."
  "$ISO" keys "$name"
  say "next: in the app, replace the Supabase URL and anon key with the two above (Vercel env vars),"
  say "      then: $ISO site $name https://<your-app-domain>"
  say "      users sign in again once (new signing key); their passwords are the same."
}

run_shared() {
  local a="$1" name="$2" schemas="$3" dump="$4" before="$5" fk="$6"
  [[ "$schemas" != *,* ]] || die "shared import takes one schema (use --schemas); it becomes schema $name"
  [ "$(psql_local -d postgres -c "select count(*) from pg_namespace where nspname = '$name'")" = 0 ] || die "schema $name already exists on the Pi"
  if [ -n "$fk" ]; then
    local refs; refs="$( { printf 'select 0'; tr ',' '\n' <<<"$fk" | sed 's/^\([^.]*\)\.\([^.]*\)\.\(.*\)$/ + (select count(*) from "\1"."\2" where "\3" is not null)/'; echo ';'; } | src_sql "$a")"
    [ "${refs:-0}" = 0 ] || die "$refs row(s) point at the cloud project's users; import it --as isolated so the users come too"
  fi
  local tmp="imp_${name}_$$"; TMPDB="$tmp"
  say "== 1/5 staging database"
  psql_local -d postgres -c "create database $tmp" >/dev/null
  # stand-ins for the Supabase auth helpers that policies and defaults call (the real ones are in the main database)
  psql_local -d "$tmp" >/dev/null <<'SQL'
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as 'select null::uuid';
create function auth.role() returns text language sql stable as 'select null::text';
create function auth.email() returns text language sql stable as 'select null::text';
create function auth.jwt() returns jsonb language sql stable as 'select null::jsonb';
SQL
  ensure_extensions "$tmp"
  say "== 2/5 copying schema $schemas from the cloud"
  cloud_dump "$a" "$schemas" "$dump"
  docker exec -i "$DB_HOST" psql -h localhost -U supabase_admin -d "$tmp" -v ON_ERROR_STOP=1 -q --single-transaction \
    -c "set session_replication_role = replica" -f - < "$dump" >/dev/null || die "restore into staging failed; nothing changed"
  [ "$schemas" = "$name" ] || psql_local -d "$tmp" -c "alter schema \"$schemas\" rename to \"$name\"" >/dev/null
  local hard; hard="$(psql_local -d "$tmp" -c "select string_agg(p.proname, ', ') from pg_proc p where p.pronamespace = '$name'::regnamespace
           and (p.prosrc ~* '\\m$schemas\\.' or array_to_string(p.proconfig, ',') ~* 'search_path=.*\\m$schemas\\M')")"
  say "== 3/5 moving it into the main database as schema $name"
  ensure_extensions postgres
  docker exec "$DB_HOST" pg_dump -h localhost -U supabase_admin -d "$tmp" --schema="$name" --no-owner \
    | docker exec -i "$DB_HOST" psql -h localhost -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q --single-transaction >/dev/null \
    || die "moving into the main database failed; nothing changed"
  say "== 4/5 grants and API"
  psql_local -d postgres >/dev/null <<SQL
grant usage on schema "$name" to anon, authenticated, service_role;
alter default privileges for role postgres in schema "$name" grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema "$name" grant all on routines to anon, authenticated, service_role;
alter default privileges for role postgres in schema "$name" grant all on sequences to anon, authenticated, service_role;
SQL
  [ "${IMPORT_SKIP_EXPOSE:-}" = 1 ] || "$EXPOSE" add "$name" >/dev/null
  say "== 5/5 verifying"
  local after; after="$(psql_local -d postgres -c "$(count_sql "$name")")"
  local b2; b2="$(sed "s/\(^\|,\)$schemas\./\1$name./g" <<<"$before")"
  if [ "$b2" != "$after" ]; then echo "cloud: $b2" >&2; echo "Pi:    $after" >&2; die "row counts differ; schema $name kept for inspection"; fi
  say "   tables: ${after:-none}"
  say ""
  say "imported '$a' as shared schema $name. The cloud project was not changed."
  [ -z "$hard" ] || say "CHECK: these functions mention '$schemas' by name and may need editing to '$name': $hard"
  say "next: in the app use the Pi's URL and anon key (Pi Console > Connect) with db: { schema: '$name' }"
}

list_aliases() { mkdir -p "$CONF"; find "$CONF" -name '*.url' -printf '%f\n' | sed 's/\.url$//' | sort; }

cmd="${1:-}"; shift || true
case "$cmd" in
  add) add "${1:-}" ;;
  inspect) inspect "${1:-}" ;;
  run) run "$@" ;;
  list) list_aliases ;;
  forget) need_alias "${1:-}"; rm -f "$(url_file "$1")"; echo "forgot $1" ;;
  *) sed -n 2,22p "$0"; exit 1 ;;
esac
