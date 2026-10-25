#!/usr/bin/env bash
# Prove a backup can actually be restored, without touching the live database.
# Restores a dump into a throw-away database "restore_test" inside the same Postgres,
# compares tables and row counts of every app schema with the live database, then drops it.
#
#   ./restore-test.sh                 newest /mnt/data/backups/db-*.dump
#   ./restore-test.sh FILE.dump
#
# Needs free disk roughly the size of the database. Read-only for the live data.
set -euo pipefail
BACKUP_DIR="${BACKUP_DIR:-/mnt/data/backups}"
DUMP="${1:-$(ls -1t "$BACKUP_DIR"/db-*.dump 2>/dev/null | head -1)}"
[ -f "$DUMP" ] || { echo "no dump found" >&2; exit 1; }
DB=restore_test
PSQL=(docker exec -i supabase-db psql -h localhost -U supabase_admin -v ON_ERROR_STOP=1 -qAt)

echo "restoring $(basename "$DUMP") ($(du -h "$DUMP" | cut -f1)) into $DB ..."
"${PSQL[@]}" -d postgres -c "drop database if exists $DB" -c "create database $DB"
trap '"${PSQL[@]}" -d postgres -c "drop database if exists '"$DB"'" >/dev/null 2>&1 || true' EXIT

# Supabase dumps contain objects only the platform can recreate (some extensions, event
# triggers); those produce errors that do not affect app data, so count rather than abort.
errors="$(docker exec -i supabase-db pg_restore -h localhost -U supabase_admin -d "$DB" < "$DUMP" 2>&1 | grep -c 'error:' || true)"

# exact row counts of app tables (same schema filter as Pi Console's project list)
counts_sql="
select n.nspname||'.'||c.relname, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r','p') and n.nspname not like 'pg\_%' and n.nspname not in
 ('information_schema','auth','storage','realtime','_realtime','supabase_functions','supabase_migrations','extensions',
  'graphql','graphql_public','vault','pgsodium','pgsodium_masks','net','cron','_analytics','pgbouncer','pgtle','_supavisor')
order by 1;"
live="$("${PSQL[@]}" -d postgres -c "$counts_sql")"
rest="$("${PSQL[@]}" -d "$DB" -c "$counts_sql")"
auth_live="$("${PSQL[@]}" -d postgres -c 'select count(*) from auth.users')"
auth_rest="$("${PSQL[@]}" -d "$DB" -c 'select count(*) from auth.users' 2>/dev/null || echo missing)"

tables=$(printf '%s\n' "$live" | sed '/^$/d' | wc -l)
echo "app tables live: $tables   auth users live/restored: $auth_live/$auth_rest   non-fatal restore errors: $errors"
if [ "$live" = "$rest" ] && [ "$auth_live" = "$auth_rest" ]; then
  echo "RESTORE TEST PASSED (tables and row counts match; rows added since the dump would show as differences)"
  date -Is > "$BACKUP_DIR/.restore-test-ok"
else
  echo "RESTORE TEST: DIFFERENCES (expected only for rows written after the dump):"
  diff <(printf '%s\n' "$live") <(printf '%s\n' "$rest") | sed 's/^</live:    /;s/^>/restored:/' | grep -E '^(live|restored)' | head -40
  exit 2
fi
