#!/usr/bin/env bash
# Add or remove a schema from the REST API (PGRST_DB_SCHEMAS) and restart only the REST service.
# Used by Pi Console for app branches; does not create or drop any data.
#
#   ./expose-schema.sh add myapp_dev
#   ./expose-schema.sh remove myapp_dev
set -euo pipefail
. "$(dirname "$0")/lib-env.sh"
cmd="${1:-}"; name="${2:-}"
[[ "$name" =~ ^[a-z][a-z0-9_]{1,62}$ ]] || { echo "bad schema name" >&2; exit 1; }
case "$name" in public|graphql_public|auth|storage|extensions) echo "refusing to change '$name'" >&2; exit 1;; esac

cur="$(get_env PGRST_DB_SCHEMAS)"
has() { tr ',' '\n' <<<"$cur" | grep -qx "$name"; }
case "$cmd" in
  add)    has && { echo "already exposed"; exit 0; }; new="${cur:+$cur,}$name" ;;
  remove) has || { echo "not exposed"; exit 0; }; new="$(tr ',' '\n' <<<"$cur" | grep -vx "$name" | paste -sd, -)" ;;
  *) sed -n 2,7p "$0"; exit 1 ;;
esac
set_env PGRST_DB_SCHEMAS "$new"
restart_services rest
echo "PGRST_DB_SCHEMAS=$new"
