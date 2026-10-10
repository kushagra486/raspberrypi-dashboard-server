#!/usr/bin/env bash
# Give a new app its own Postgres schema inside the one Supabase instance.
#
#   ./new-project.sh ecommerce
#
# Then in that app:   createClient(URL, ANON_KEY, { db: { schema: 'ecommerce' } })
# Every app shares the same URL, keys and Auth users; data stays separated by schema.
# Turn on Row Level Security on your tables, because the anon key is public.
set -euo pipefail

NAME="${1:-}"
PROJECT_DIR="${PROJECT_DIR:-$HOME/supabase-project}"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$NAME" =~ ^[a-z][a-z0-9_]{1,30}$ ]] || die "name must be lowercase letters, digits, underscores (2-31 chars), starting with a letter"
case "$NAME" in
  public|auth|storage|realtime|extensions|graphql|graphql_public|vault|pg_catalog|information_schema|supabase_functions|_realtime|_analytics|net|pgsodium|cron)
    die "'$NAME' is reserved by Supabase" ;;
esac

cd "$PROJECT_DIR"
docker ps --format '{{.Names}}' | grep -qx supabase-db || die "supabase-db is not running"

docker exec -i supabase-db psql -h localhost -U supabase_admin -d postgres -v ON_ERROR_STOP=1 <<SQL
create schema if not exists "$NAME";
grant usage on schema "$NAME" to anon, authenticated, service_role;
grant all on all tables    in schema "$NAME" to anon, authenticated, service_role;
grant all on all routines  in schema "$NAME" to anon, authenticated, service_role;
grant all on all sequences in schema "$NAME" to anon, authenticated, service_role;
alter default privileges for role postgres in schema "$NAME" grant all on tables    to anon, authenticated, service_role;
alter default privileges for role postgres in schema "$NAME" grant all on routines  to anon, authenticated, service_role;
alter default privileges for role postgres in schema "$NAME" grant all on sequences to anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema "$NAME" grant all on tables    to anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema "$NAME" grant all on routines  to anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema "$NAME" grant all on sequences to anon, authenticated, service_role;
SQL

CURRENT="$(grep '^PGRST_DB_SCHEMAS=' .env | cut -d= -f2-)"
if [[ ",$CURRENT," == *",$NAME,"* ]]; then
  echo "schema '$NAME' is already exposed through the API"
else
  sed -i "s|^PGRST_DB_SCHEMAS=.*|PGRST_DB_SCHEMAS=${CURRENT},${NAME}|" .env
  echo "added '$NAME' to PGRST_DB_SCHEMAS; restarting the REST service"
  sh run.sh recreate rest
fi

echo "done. Open Studio, switch the schema dropdown to '$NAME', and create tables there."
