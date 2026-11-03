#!/usr/bin/env bash
# Proves cloud-import.sh end to end against two stand-in "cloud" projects that live in the local database
# server (a real Supabase Auth schema with users, and a plain one without). Everything is removed at the end.
#
#   TEST_DB_PASSWORD=<supabase_admin password of the local database> ./test-cloud-import.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMP="$HERE/cloud-import.sh"; ISO="$HERE/../isolated/iso-project.sh"
ISO_DIR="${ISO_DIR:-$HOME/supabase-project/isolated}"
DB_HOST="${ISO_DB_HOST:-supabase-db}"
BASE="http://127.0.0.1:${ISO_PROXY_PORT:-8100}/p"
export PI_IMPORT_DIR; PI_IMPORT_DIR="$(mktemp -d)"; export PI_IMPORT_WORK="$PI_IMPORT_DIR/work"
SRC=isotest_cloud; DST=isotest_imp; SH=isotest_blog
pass=0; fail=0
ok()  { echo "  PASS  $*"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $*"; fail=$((fail + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected $3, got $2)"; fi; }
sqlp() { docker exec -i "$DB_HOST" psql -h localhost -U supabase_admin -qAt -d "$1" -c "$2" 2>&1; }
v() { grep -E "^$2=" "$ISO_DIR/projects/$1/project.env" | cut -d= -f2-; }
: "${TEST_DB_PASSWORD:?set TEST_DB_PASSWORD}"
url() { printf 'postgresql://supabase_admin:%s@localhost:5432/%s?sslmode=disable' "$TEST_DB_PASSWORD" "$1"; }

cleanup() {
  for p in $DST $SRC; do [ -d "$ISO_DIR/projects/$p" ] && "$ISO" remove $p --drop-data >/dev/null 2>&1; done
  sqlp postgres "drop schema if exists $SH cascade" >/dev/null
  sqlp postgres "drop database if exists fake_blog with (force)" >/dev/null
  rm -rf "$PI_IMPORT_DIR" "${BACKUP_DIR:-/mnt/data/backups}/$DST" "${BACKUP_DIR:-/mnt/data/backups}/$SRC"
}
trap cleanup EXIT
cleanup >/dev/null 2>&1; mkdir -p "$PI_IMPORT_DIR"

echo "== stand-in cloud project with real Supabase Auth, users, a new-user trigger, RLS and policies"
ISO_QUIET_KEYS=1 "$ISO" create $SRC >/dev/null || { echo "could not create the stand-in"; exit 1; }
sqlp proj_$SRC "create schema if not exists extensions; create extension if not exists \"uuid-ossp\" with schema extensions;
  create table public.profiles (id uuid primary key references auth.users(id) on delete cascade, email text);
  create table public.notes (id bigserial primary key, ref uuid default extensions.uuid_generate_v4(),
    user_id uuid not null default auth.uid() references auth.users(id), body text);
  alter table public.profiles enable row level security; alter table public.notes enable row level security;
  create policy own on public.notes for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
  create policy me on public.profiles for select to authenticated using (id = auth.uid());
  grant select, insert on public.notes, public.profiles to authenticated; grant usage on sequence public.notes_id_seq to authenticated;
  create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as
    'begin insert into public.profiles (id, email) values (new.id, new.email); return new; end';
  create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();" >/dev/null
S="$(v $SRC SERVICE_KEY)"; PW="$(openssl rand -hex 12)"
for u in ana ben cy; do
  curl -s -o /dev/null -X POST -H "apikey: $S" -H "Authorization: Bearer $S" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$u@example.com\",\"password\":\"$PW\",\"email_confirm\":true}" "$BASE/$SRC/auth/v1/admin/users"
done
sqlp proj_$SRC "insert into public.notes (user_id, body) select id, 'note of ' || email from auth.users, generate_series(1, 2)" >/dev/null
check "stand-in has 3 users" "$(sqlp proj_$SRC "select count(*) from auth.users")" 3
check "trigger made 3 profiles" "$(sqlp proj_$SRC "select count(*) from public.profiles")" 3
fp_before="$(sqlp proj_$SRC "select md5(string_agg(t::text, ',' order by t::text)) from (select * from public.notes) t")|$(sqlp proj_$SRC "select count(*) from auth.users")"

echo "== add: the connection string is typed hidden, checked, stored mode 600"
{ sleep 2; printf '%s\n' "$(url proj_$SRC)"; } | script -qc "$IMP add cloudapp" /dev/null > /tmp/imp-add.log 2>&1
grep -q "saved as 'cloudapp'" /tmp/imp-add.log && ok "add saved it" || bad "add ($(tail -2 /tmp/imp-add.log))"
check "stored file is private" "$(stat -c %a "$PI_IMPORT_DIR/cloudapp.url" 2>/dev/null)" 600
{ sleep 2; printf 'not-a-url\n'; } | script -qc "$IMP add broken" /dev/null >/dev/null 2>&1
check "a wrong string is not saved" "$(ls "$PI_IMPORT_DIR"/broken.url 2>/dev/null | wc -l | tr -d ' ')" 0
echo "x" | "$IMP" add piped >/dev/null 2>&1; check "add refuses piped input (must be typed)" "$?" 1

echo "== inspect"
"$IMP" inspect cloudapp > /tmp/imp-inspect.log 2>&1 || bad "inspect failed"
grep -q "sign-up users: 3" /tmp/imp-inspect.log && ok "inspect counts users" || bad "inspect users"
grep -q "on_auth_user_created" /tmp/imp-inspect.log && ok "inspect lists the new-user trigger" || bad "inspect trigger"
grep -q "RECOMMENDED: isolated" /tmp/imp-inspect.log && ok "inspect recommends isolated" || bad "inspect recommendation"

echo "== refuse shared for a project whose rows point at its users"
"$IMP" run cloudapp --as shared --name $SH >/tmp/imp-refuse.log 2>&1; check "shared refused" "$?" 1
grep -q "as isolated" /tmp/imp-refuse.log && ok "refusal says why" || bad "refusal reason ($(tail -1 /tmp/imp-refuse.log))"

echo "== import as isolated"
"$IMP" run cloudapp --as isolated --name $DST > /tmp/imp-run.log 2>&1 && ok "import finished" || { bad "import failed"; cat /tmp/imp-run.log; }
check "users copied" "$(sqlp proj_$DST "select count(*) from auth.users")" 3
check "identities copied" "$(sqlp proj_$DST "select count(*) from auth.identities")" 3
check "notes copied" "$(sqlp proj_$DST "select count(*) from public.notes")" 6
check "RLS and policies kept" "$(sqlp proj_$DST "select count(*) from pg_policies where schemaname = 'public'")" 2
A="$(v $DST ANON_KEY)"
T="$(curl -s -X POST -H "apikey: $A" -H 'Content-Type: application/json' -d "{\"email\":\"ben@example.com\",\"password\":\"$PW\"}" \
  "$BASE/$DST/auth/v1/token?grant_type=password" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
[ -n "$T" ] && ok "an imported user signs in with the old password" || bad "imported user cannot sign in"
check "they see only their own notes (RLS)" "$(curl -s -H "apikey: $A" -H "Authorization: Bearer $T" "$BASE/$DST/rest/v1/notes?select=body" | grep -o 'note of ben' | wc -l | tr -d ' ')" 2
check "and none of anyone else's" "$(curl -s -H "apikey: $A" -H "Authorization: Bearer $T" "$BASE/$DST/rest/v1/notes?select=body" | grep -o '"body"' | wc -l | tr -d ' ')" 2
check "they can add a note (sequence + default auth.uid())" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "apikey: $A" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"body":"new"}' "$BASE/$DST/rest/v1/notes")" 201
curl -s -o /dev/null -X POST -H "apikey: $A" -H 'Content-Type: application/json' -d "{\"email\":\"dee@example.com\",\"password\":\"$PW\"}" "$BASE/$DST/auth/v1/signup"
check "new-user trigger copied: a new sign-up gets a profile" "$(sqlp proj_$DST "select count(*) from public.profiles p join auth.users u on u.id = p.id where u.email = 'dee@example.com'")" 1
check "the cloud project was not changed" "$(sqlp proj_$SRC "select md5(string_agg(t::text, ',' order by t::text)) from (select * from public.notes) t")|$(sqlp proj_$SRC "select count(*) from auth.users")" "$fp_before"
"$IMP" run cloudapp --as isolated --name $DST >/dev/null 2>&1; check "importing over an existing project is refused" "$?" 1
check "and the existing project is left alone" "$(sqlp proj_$DST "select count(*) from public.notes")" 7

echo "== stand-in cloud project without users, imported as shared (schema renamed)"
sqlp postgres "create database fake_blog" >/dev/null
sqlp fake_blog "create schema auth; create table auth.users (id uuid primary key); create table auth.identities (id uuid, provider text);
  create function auth.uid() returns uuid language sql stable as 'select null::uuid';
  create table public.posts (id bigserial primary key, title text not null, author uuid references auth.users(id));
  create table public.tags (post_id bigint references public.posts(id), tag text);
  alter table public.posts enable row level security;
  create policy read on public.posts for select to anon using (true);
  grant select on public.posts to anon;
  create function public.recent() returns setof public.posts language sql stable as 'select * from public.posts order by id desc limit 5';
  insert into public.posts (title) select 'post ' || g from generate_series(1, 25) g;
  insert into public.tags select id, 'x' from public.posts where id <= 10;" >/dev/null
(umask 077; url fake_blog > "$PI_IMPORT_DIR/blog.url")
"$IMP" inspect blog > /tmp/imp-inspect2.log 2>&1 && grep -q "RECOMMENDED: shared" /tmp/imp-inspect2.log && ok "inspect recommends shared" || bad "inspect shared"
IMPORT_SKIP_EXPOSE=1 "$IMP" run blog --as shared --name $SH > /tmp/imp-shared.log 2>&1 && ok "shared import finished" || { bad "shared import failed"; cat /tmp/imp-shared.log; }
check "posts in schema $SH" "$(sqlp postgres "select count(*) from $SH.posts")" 25
check "tags in schema $SH" "$(sqlp postgres "select count(*) from $SH.tags")" 10
check "policy kept" "$(sqlp postgres "select count(*) from pg_policies where schemaname = '$SH'")" 1
check "sequence continues" "$(sqlp postgres "insert into $SH.posts (title) values ('next') returning id")" 26
grep -q "CHECK: .*recent" /tmp/imp-shared.log && ok "warns about a function that names the old schema" || bad "no warning for recent()"
check "staging database removed" "$(sqlp postgres "select count(*) from pg_database where datname like 'imp_%'")" 0
check "nothing created in public of the main database" "$(sqlp postgres "select count(*) from pg_tables where schemaname = 'public' and tablename in ('posts','tags')")" 0

echo "== secrets"
check "password never printed" "$(cat /tmp/imp-*.log | grep -c "$TEST_DB_PASSWORD")" 0
"$IMP" list | grep -q cloudapp && ok "list shows aliases" || bad "list"
"$IMP" forget cloudapp >/dev/null; check "forget deletes the stored string" "$(ls "$PI_IMPORT_DIR"/cloudapp.url 2>/dev/null | wc -l | tr -d ' ')" 0

echo
echo "cloud import test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
