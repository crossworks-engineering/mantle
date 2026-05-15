#!/usr/bin/env bash
# Reset the Supabase-managed admin role passwords to match the current
# POSTGRES_PASSWORD in .env.
#
# When to run this:
#   * After deploying a rsync'd Postgres data dir into a new env (the
#     data dir keeps the OLD POSTGRES_PASSWORD's role passwords —
#     supabase_auth_admin and supabase_storage_admin can't connect with
#     the new value, so auth + storage crash-loop with
#     "FATAL: password authentication failed for user supabase_auth_admin").
#   * After rotating POSTGRES_PASSWORD on an existing deployment.
#
# Run from the server, inside ~/mcp.cwe.cloud (or wherever the compose
# lives). Assumes the mantle_db container is up.
#
# Mechanism: the Supabase Postgres image hard-codes
#   hba_file = /etc/postgresql/pg_hba.conf
# (NOT the one in the data dir). And the rule for `supabase_admin` over
# the local socket is `scram-sha-256` — i.e. needs a password, and we
# don't know the old one. So:
#   1. Edit that pg_hba.conf inside the container to add
#      `local all all trust` at the top.
#   2. Reload Postgres (SIGHUP via pg_ctl reload).
#   3. Connect as supabase_admin (now trusted) and ALTER ROLE every
#      reserved admin user to use $POSTGRES_PASSWORD.
#   4. Strip the trust line, reload again. Trap ensures step 4 happens
#      even if step 3 errors out.
#
# After this runs, `docker compose restart auth storage` should clear
# the crash loops.
set -euo pipefail

COMPOSE_DIR="${1:-$HOME/mcp.cwe.cloud/infra/supabase}"
DB_CONTAINER="${MANTLE_DB_CONTAINER:-mantle_db}"
HBA=/etc/postgresql/pg_hba.conf
TAG="MANTLE_TEMP_TRUST"

cd "$COMPOSE_DIR"
[[ -f .env ]] || { echo "✗ no .env in $COMPOSE_DIR" >&2; exit 1; }
set -a; source .env; set +a
[[ -n "${POSTGRES_PASSWORD:-}" ]] || { echo "✗ POSTGRES_PASSWORD not set in .env" >&2; exit 1; }

docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER" \
  || { echo "✗ container $DB_CONTAINER is not running" >&2; exit 1; }

revert_hba() {
  echo "→ restoring pg_hba.conf"
  docker exec -u postgres "$DB_CONTAINER" sh -c "
    grep -v '$TAG' '$HBA' > /tmp/_hba && cp /tmp/_hba '$HBA' && rm /tmp/_hba
    pg_ctl reload -D /var/lib/postgresql/data >/dev/null 2>&1 || true
  "
}
trap revert_hba EXIT

echo "→ adding temporary local-trust rule to $HBA"
docker exec -u postgres "$DB_CONTAINER" sh -c "
  cp '$HBA' '$HBA.bak.\$(date +%s)'
  { echo 'local all all trust # $TAG'; cat '$HBA'; } > /tmp/_hba
  cp /tmp/_hba '$HBA' && rm /tmp/_hba
  pg_ctl reload -D /var/lib/postgresql/data
"
sleep 1

echo "→ resetting role passwords (as supabase_admin via trust auth)"
docker exec -u postgres -i "$DB_CONTAINER" psql -U supabase_admin -d postgres \
  -v new_pw="$POSTGRES_PASSWORD" <<'SQL'
\set ON_ERROR_STOP on
ALTER ROLE supabase_admin             PASSWORD :'new_pw';
ALTER ROLE supabase_auth_admin        PASSWORD :'new_pw';
ALTER ROLE supabase_storage_admin     PASSWORD :'new_pw';
ALTER ROLE supabase_read_only_user    PASSWORD :'new_pw';
ALTER ROLE supabase_replication_admin PASSWORD :'new_pw';
ALTER ROLE authenticator              PASSWORD :'new_pw';
ALTER ROLE postgres                   PASSWORD :'new_pw';
\echo ✓ all reserved roles updated
SQL

echo
echo "→ verifying from the docker network (the way auth + storage connect)"
docker run --rm --network mantle_supabase \
  -e PGPASSWORD="$POSTGRES_PASSWORD" \
  public.ecr.aws/supabase/postgres:17.6.1.106 \
  psql -h db -U supabase_auth_admin -d postgres \
  -c "select 'ok' as status, current_user;"

echo
echo "✓ passwords aligned. pg_hba.conf restored by exit trap."
echo "  Next: docker compose restart auth storage  # if they were crash-looping"
