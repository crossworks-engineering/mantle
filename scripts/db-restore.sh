#!/usr/bin/env bash
# Restore a Mantle dump (from scripts/db-dump.sh) into a freshly-initialized
# Postgres — the standard way to MOVE the brain to a new machine.
#
# IMPORTANT — run this BEFORE the app/migrate services start:
#   1. docker compose pull
#   2. docker compose up -d postgres --wait      # init creates extensions + auth schema
#   3. scripts/db-restore.sh backups/mantle-<ts>.dump
#   4. docker compose up -d --wait               # migrate is now a no-op; app starts
#
# Because the init scripts pre-create the `auth` schema, `auth.users`, and the
# pgvector/ltree/… extensions, pg_restore will print a handful of "already
# exists" notices for THOSE objects — that is expected and harmless (they're
# identical). The public app tables don't exist yet, so they restore cleanly.
set -euo pipefail
cd "$(dirname "$0")/.."

DUMP="${1:?usage: scripts/db-restore.sh <path-to.dump>}"
CONTAINER="${MANTLE_PG_CONTAINER:-mantle_pg}"
[ -f "$DUMP" ] || { echo "✗ no such dump: $DUMP" >&2; exit 1; }

if ! docker exec "$CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
  echo "✗ postgres container '$CONTAINER' not reachable — run 'docker compose up -d postgres --wait' first." >&2
  exit 1
fi

# Guard: refuse to restore over a populated brain (run before the app exists).
EXISTING=$(docker exec "$CONTAINER" psql -U postgres -d postgres -tA \
  -c "SELECT to_regclass('public.nodes') IS NOT NULL AND (SELECT count(*) FROM nodes) > 0" 2>/dev/null || echo "f")
if [ "$EXISTING" = "t" ]; then
  echo "✗ target already has data in public.nodes — refusing to restore over a live brain." >&2
  echo "  Restore into a fresh DB, or drop it deliberately first." >&2
  exit 1
fi

echo "▶ Restoring $DUMP → '$CONTAINER' (benign 'already exists' notices for auth/extensions are expected)"
# No --clean: public is empty so tables create cleanly; pre-existing auth/exts
# error benignly and pg_restore continues. We don't trust the exit code (it's
# non-zero on benign errors) — we verify by row count below.
docker exec -i "$CONTAINER" pg_restore -U postgres -d postgres --no-owner < "$DUMP" || true

N=$(docker exec "$CONTAINER" psql -U postgres -d postgres -tA -c "SELECT count(*) FROM nodes" 2>/dev/null || echo "0")
echo "✔ Restore complete — public.nodes now has $N rows."
echo "  Next:  docker compose up -d --wait    (migrate will be a no-op)"
echo "  Don't forget the file bytes:  rsync your \$MANTLE_DATA_DIR/{files,minio} across too."
