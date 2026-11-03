#!/usr/bin/env bash
# Proves "Make isolated" end to end with a throw-away SHARED project (schema isotest_m in the
# main database): migrate, use it through its new address the way an app does, retire the
# shared copy, and refuse a project whose rows point at shared-pool users. Everything it
# creates is removed at the end. Real projects are never touched.
#
#   ./test-migrate.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ISO="$HERE/iso-project.sh"
ISO_DIR="${ISO_DIR:-$HOME/supabase-project/isolated}"
MAIN_ENV="${MAIN_ENV:-$HOME/supabase-project/.env}"
BACKUP_DIR="${BACKUP_DIR:-/mnt/data/backups}"
DB_HOST="${ISO_DB_HOST:-supabase-db}"
BASE="http://127.0.0.1:${ISO_PROXY_PORT:-8100}/p"
M=isotest_m; R=isotest_r
pass=0; fail=0
ok()  { echo "  PASS  $*"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $*"; fail=$((fail + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected $3, got $2)"; fi; }
sqlp() { docker exec -i "$DB_HOST" psql -h localhost -U supabase_admin -qAt -d "$1" -c "$2" 2>&1; }
v() { grep -E "^$2=" "$ISO_DIR/projects/$1/project.env" | cut -d= -f2-; }

cleanup() {
  [ -d "$ISO_DIR/projects/$M" ] && "$ISO" remove $M --drop-data >/dev/null 2>&1
  sqlp postgres "set client_min_messages = warning; drop schema if exists $M cascade; drop schema if exists $R cascade;
                 delete from auth.users where email = 'isotest-shared@example.com'" >/dev/null
  rm -rf "${BACKUP_DIR:?}/$M"
}
trap cleanup EXIT
cleanup

echo "== a shared project with UUID keys, a sequence, FKs, RLS, auth.uid() policies and grants"
sqlp postgres "create schema $M;
  grant usage on schema $M to anon, authenticated, service_role;
  create table $M.products (id uuid primary key default gen_random_uuid(), name text not null);
  create table $M.orders (id bigserial primary key, product_id uuid not null references $M.products(id),
    user_id uuid references auth.users(id) default auth.uid(), qty int not null default 1);
  alter table $M.products enable row level security;
  alter table $M.orders enable row level security;
  create policy pr on $M.products for select to anon, authenticated using (true);
  create policy own on $M.orders for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
  grant select on $M.products to anon, authenticated;
  grant select, insert on $M.orders to authenticated;
  grant usage on sequence $M.orders_id_seq to authenticated;
  insert into $M.products (name) select 'p' || g from generate_series(1, 7) g;
  insert into $M.orders (product_id) select id from $M.products limit 4;" >/dev/null
check "shared project ready" "$(sqlp postgres "select count(*) from $M.products")" 7

echo "== migrate"
"$ISO" migrate $M >/tmp/isotest-migrate.log 2>&1 && ok "migrate finished" || { bad "migrate failed"; cat /tmp/isotest-migrate.log; }
check "products copied" "$(sqlp proj_$M "select count(*) from $M.products")" 7
check "orders copied" "$(sqlp proj_$M "select count(*) from $M.orders")" 4
check "RLS kept" "$(sqlp proj_$M "select bool_and(relrowsecurity) from pg_class where relnamespace = '$M'::regnamespace and relkind = 'r'")" t
check "policies kept" "$(sqlp proj_$M "select count(*) from pg_policies where schemaname = '$M'")" 2
check "shared copy untouched" "$(sqlp postgres "select count(*) from $M.orders")" 4

echo "== used like an app: same schema name, new URL and key"
A="$(v $M ANON_KEY)"; S="$(v $M SERVICE_KEY)"
PW="$(openssl rand -hex 12)"   # throw-away user, random each run
check "anon reads products" "$(curl -s -H "apikey: $A" -H "Authorization: Bearer $A" -H "Accept-Profile: $M" "$BASE/$M/rest/v1/products?select=name" | grep -o '"name"' | wc -l | tr -d ' ')" 7
curl -s -o /dev/null -X POST -H "apikey: $S" -H "Authorization: Bearer $S" -H 'Content-Type: application/json' \
  -d "{\"email\":\"buyer@example.com\",\"password\":\"$PW\",\"email_confirm\":true}" "$BASE/$M/auth/v1/admin/users"
T="$(curl -s -X POST -H "apikey: $A" -H 'Content-Type: application/json' -d "{\"email\":\"buyer@example.com\",\"password\":\"$PW\"}" \
  "$BASE/$M/auth/v1/token?grant_type=password" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
P="$(curl -s -H "apikey: $A" -H "Authorization: Bearer $A" -H "Accept-Profile: $M" "$BASE/$M/rest/v1/products?select=id&limit=1" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
check "a new user orders through the new address" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "apikey: $A" -H "Authorization: Bearer $T" \
  -H "Content-Profile: $M" -H 'Content-Type: application/json' -d "{\"product_id\":\"$P\"}" "$BASE/$M/rest/v1/orders")" 201
check "the order got the next id from its own sequence" "$(sqlp proj_$M "select max(id) from $M.orders")" 5
check "the user exists only in the isolated project" "$(sqlp postgres "select count(*) from auth.users where email = 'buyer@example.com'")" 0
check "the shared copy did not receive the order" "$(sqlp postgres "select count(*) from $M.orders")" 4

echo "== retire the shared copy"
"$ISO" retire-shared $M >/dev/null 2>&1; check "refused without --confirm" "$?" 1
"$ISO" retire-shared $M --confirm >/dev/null 2>&1 || true
check "shared schema dropped" "$(sqlp postgres "select count(*) from pg_namespace where nspname = '$M'")" 0
check "final backup of the shared copy kept" "$(ls "$BACKUP_DIR/$M"/shared-final-*.dump 2>/dev/null | wc -l | tr -d ' ')" 1
check "isolated copy still complete" "$(sqlp proj_$M "select count(*) from $M.orders")" 5

echo "== refuse a project whose rows point at shared-pool users"
sqlp postgres "create schema $R; create table $R.notes (id int primary key, owner uuid references auth.users(id));
  insert into auth.users (id, email) values (gen_random_uuid(), 'isotest-shared@example.com');
  insert into $R.notes select 1, id from auth.users where email = 'isotest-shared@example.com';" >/dev/null
out="$("$ISO" migrate $R 2>&1)"; rc=$?
check "migration refused" "$rc" 1
grep -q "shared user pool" <<<"$out" && ok "refusal names the reason" || bad "refusal names the reason ($out)"
check "nothing created for the refused project" "$(sqlp postgres "select count(*) from pg_database where datname = 'proj_$R'")" 0

echo
echo "migration test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
