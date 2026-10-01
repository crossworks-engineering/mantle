#!/usr/bin/env bash
# Migrate the demo box's brain and leave every app role read-only. Runs ON THE
# BOX, from inside the unpacked bundle directory. restore.sh calls it; run it
# yourself after you change MANTLE_IMAGE_TAG in .env.demo (a roll):
#
#   ./migrate-readonly.sh
#   docker compose -f docker-compose.demo.yml --env-file .env.demo up -d --wait web client
#
# It is ONE script because the steps are only safe together, in this order:
#
#   1. migrate, as the OWNER, through the server image. It applies what the
#      pinned image has that the brain does not, and gives the level roles
#      their login, password and grants. Those grants include INSERT, UPDATE
#      and DELETE on the space tables for mantle_view_space: every migrate
#      puts them back.
#   2. readonly-role.sql: demo_reader, and the write verbs taken from the
#      level roles again.
#   3. function-privileges.sql: the EXECUTE restrictions the dump could not
#      carry (it is taken without privileges).
#   4. readonly-check.sql: the proof. A role that can still write stops here,
#      before the app is started.
#
# A migrate run on its own (step 1 without 2) leaves a writable role behind
# while every screen keeps working. Do not run it on its own.
set -euo pipefail
cd "$(dirname "$0")"
BUNDLE="$(pwd)"
COMPOSE=(docker compose -f "$BUNDLE/docker-compose.demo.yml" --env-file "$BUNDLE/.env.demo")
PG=mantle_demo_srv_pg
fail() { echo "✗ $1" >&2; exit 1; }
psql_file() { docker exec -i "$PG" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 < "$1"; }

[ -f "$BUNDLE/.env.demo" ] || fail "no .env.demo next to this script"
docker inspect -f '{{.State.Running}}' "$PG" 2>/dev/null | grep -q true || fail "$PG is not running"

echo "→ level roles and schema (migrate, as the owner)"
"${COMPOSE[@]}" --profile restore run --rm --no-deps -T migrate > "$BUNDLE/migrate.log" 2>&1 \
  || { tail -20 "$BUNDLE/migrate.log" >&2; fail "migrate failed: see $BUNDLE/migrate.log"; }
echo "  $(grep -E 'Already up to date|applied [0-9]+ migration' "$BUNDLE/migrate.log" | tail -1)"

echo "→ read-only roles"
psql_file "$BUNDLE/readonly-role.sql"
echo "  demo_reader ready; write verbs taken from the level roles"

echo "→ function privileges"
[ -f "$BUNDLE/function-privileges.sql" ] || fail "no function-privileges.sql in the bundle: re-pack with the current demo/scripts/pack.sh"
psql_file "$BUNDLE/function-privileges.sql"
echo "  $(grep -c '^REVOKE ' "$BUNDLE/function-privileges.sql") restricted function(s)"

echo "→ read-only check"
docker exec -i "$PG" psql -U postgres -d postgres -At -v ON_ERROR_STOP=1 < "$BUNDLE/readonly-check.sql" \
  || fail "an app role can still write: NOT starting the app"
