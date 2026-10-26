#!/usr/bin/env bash
# Proves isolation between projects, end to end, with two throw-away projects
# (isotest_a, isotest_b) that are deleted at the end. Safe to run on the Pi:
# it never touches real projects or the main Supabase data.
#
#   ./test-isolation.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISO="$HERE/iso-project.sh"
ISO_DIR="${ISO_DIR:-$HOME/supabase-project/isolated}"
PORT="${ISO_PROXY_PORT:-8100}"
DB_HOST="${ISO_DB_HOST:-supabase-db}"
BASE="http://127.0.0.1:$PORT/p"
A=isotest_a; B=isotest_b
pass=0; fail=0
ok()  { echo "  PASS  $*"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $*"; fail=$((fail + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected $3, got $2)"; fi; }
v() { grep -E "^$2=" "$ISO_DIR/projects/$1/project.env" | cut -d= -f2-; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
sqlp() { docker exec -i "$DB_HOST" psql -h localhost -U supabase_admin -qAt -d "$1" -c "$2" 2>&1; }

cleanup() {
  for p in $A $B; do [ -d "$ISO_DIR/projects/$p" ] && "$ISO" remove "$p" --drop-data >/dev/null 2>&1; done
  rm -rf "${BACKUP_DIR:-/mnt/data/backups}/$A" "${BACKUP_DIR:-/mnt/data/backups}/$B"
}
trap cleanup EXIT

main_users_before="$(sqlp postgres 'select count(*) from auth.users')"
# fingerprint every OTHER isolated project, to prove the test leaves them alone
fingerprint() {
  sqlp postgres "select datname from pg_database where datname like 'proj\_%' and datname not in ('proj_$A','proj_$B') order by 1" |
  while read -r db; do
    [ -n "$db" ] && echo "$db $(sqlp "$db" "select count(*) || ':' || coalesce(sum(n_live_tup), 0) from pg_stat_user_tables") $(sqlp "$db" 'select count(*) from auth.users')"
  done
}
bystanders_before="$(fingerprint)"
echo "== creating two throw-away projects"
"$ISO" create $A >/dev/null || { echo "create $A failed"; exit 1; }
"$ISO" create $B >/dev/null || { echo "create $B failed"; exit 1; }
AA="$(v $A ANON_KEY)"; AS="$(v $A SERVICE_KEY)"; BA="$(v $B ANON_KEY)"

echo "== keys are required and project-specific"
check "auth without key -> 401"                 "$(code "$BASE/$A/auth/v1/settings")" 401
check "rest without key -> 401"                 "$(code "$BASE/$A/rest/v1/")" 401
check "project B's key on project A -> 401"     "$(code -H "apikey: $BA" "$BASE/$A/auth/v1/settings")" 401
check "rest with key but no token -> 401"       "$(code -H "apikey: $AA" "$BASE/$A/rest/v1/")" 401
check "project A with its own key -> 200"       "$(code -H "apikey: $AA" "$BASE/$A/auth/v1/settings")" 200
check "unknown project -> 404"                  "$(code -H "apikey: $AA" "$BASE/nope/auth/v1/settings")" 404
pre="$(curl -s -o /dev/null -D - -X OPTIONS -H 'Origin: https://app.example' -H 'Access-Control-Request-Method: POST' "$BASE/$A/rest/v1/notes")"
case "$(head -1 <<<"$pre" | awk '{print $2}')" in 200|204) ok "CORS preflight allowed without key";; *) bad "CORS preflight allowed without key";; esac
grep -qi '^access-control-allow-origin:' <<<"$pre" && ok "CORS headers present" || bad "CORS headers present"

echo "== a user of project A lives only in project A"
check "create user in A (admin API)" "$(code -X POST -H "apikey: $AS" -H "Authorization: Bearer $AS" -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"correct-horse-1","email_confirm":true}' "$BASE/$A/auth/v1/admin/users")" 200
TOKEN="$(curl -s -X POST -H "apikey: $AA" -H 'Content-Type: application/json' -d '{"email":"alice@example.com","password":"correct-horse-1"}' \
  "$BASE/$A/auth/v1/token?grant_type=password" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
[ -n "$TOKEN" ] && ok "alice signs in to A" || bad "alice signs in to A"
check "alice's password does not work in B" "$(code -X POST -H "apikey: $BA" -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"correct-horse-1"}' "$BASE/$B/auth/v1/token?grant_type=password")" 400
check "users in A's database"        "$(sqlp proj_$A 'select count(*) from auth.users')" 1
check "users in B's database"        "$(sqlp proj_$B 'select count(*) from auth.users')" 0
check "users in the main database unchanged" "$(sqlp postgres 'select count(*) from auth.users')" "$main_users_before"

echo "== data and row level security"
sqlp proj_$A "create table public.notes (id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid(), body text);
  alter table public.notes enable row level security;
  create policy own on public.notes for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
  notify pgrst, 'reload schema';" >/dev/null
sleep 2
check "alice writes a note in A" "$(code -X POST -H "apikey: $AA" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"body":"private"}' "$BASE/$A/rest/v1/notes")" 201
check "anon sees none of alice's notes" "$(curl -s -H "apikey: $AA" -H "Authorization: Bearer $AA" "$BASE/$A/rest/v1/notes")" "[]"
check "alice's token rejected by B's API" "$(code -H "apikey: $BA" -H "Authorization: Bearer $TOKEN" "$BASE/$B/rest/v1/")" 401
check "A's service key rejected by B's API" "$(code -H "apikey: $BA" -H "Authorization: Bearer $AS" "$BASE/$B/rest/v1/")" 401
check "table does not exist in B" "$(sqlp proj_$B "select to_regclass('public.notes') is null")" t

echo "== database logins are fenced in"
for role in "iso_${A}_api" "iso_${A}_auth"; do
  check "$role cannot connect to the main database" \
    "$(sqlp postgres "select has_database_privilege('$role', 'postgres', 'connect')")" f
  check "$role cannot connect to B's database" \
    "$(sqlp postgres "select has_database_privilege('$role', 'proj_$B', 'connect')")" f
done
check "main API login cannot connect to A's database" \
  "$(sqlp postgres "select has_database_privilege('authenticator', 'proj_$A', 'connect')")" f
check "A's own API login can connect to A" \
  "$(sqlp postgres "select has_database_privilege('iso_${A}_api', 'proj_$A', 'connect')")" t

echo "== removal"
"$ISO" remove $B --drop-data >/dev/null
check "B's database is gone" "$(sqlp postgres "select count(*) from pg_database where datname = 'proj_$B'")" 0
check "B's roles are gone" "$(sqlp postgres "select count(*) from pg_roles where rolname like 'iso_${B}_%'")" 0
check "B's address answers 404" "$(code -H "apikey: $BA" "$BASE/$B/auth/v1/settings")" 404
check "A still works after B is removed" "$(code -H "apikey: $AA" "$BASE/$A/auth/v1/settings")" 200

echo "== other projects untouched"
check "every other isolated project unchanged" "$(fingerprint)" "$bystanders_before"

echo
echo "isolation test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
