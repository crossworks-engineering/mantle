#!/usr/bin/env bash
# Restore a Mantle snapshot into a target Supabase (Postgres + Storage).
#
# Designed for: a freshly-provisioned self-hosted Supabase whose containers
# have started for the first time. Restoring into an already-populated DB
# is destructive — use --clean only if you understand the consequences.
#
# What it does:
#   1. Applies roles.sql       → pg_restore-ready role names exist on target
#   2. Restores postgres.dump  → recreates schemas, tables, data
#   3. Unpacks storage.tar     → into the target storage container
#
# Usage:
#   ./scripts/restore.sh <snapshot-dir> <target-db-container> [storage-container]
#
# Example (restoring into a fresh local self-hosted compose):
#   ./scripts/restore.sh backups/20260515-091523 mantle_db mantle_storage
#
set -euo pipefail

SNAPSHOT_DIR="${1:?usage: restore.sh <snapshot-dir> <target-db-container> [storage-container]}"
TARGET_DB="${2:?missing target DB container name}"
TARGET_STORAGE="${3:-${TARGET_DB%_db*}_storage}"

STORAGE_PATH_IN_CONTAINER="${MANTLE_STORAGE_PATH:-/mnt}"

# ── sanity ──────────────────────────────────────────────────────────────
[[ -d "$SNAPSHOT_DIR" ]] || { echo "✗ $SNAPSHOT_DIR doesn't exist" >&2; exit 1; }
[[ -f "$SNAPSHOT_DIR/roles.sql" ]]    || { echo "✗ missing roles.sql"    >&2; exit 1; }
[[ -f "$SNAPSHOT_DIR/postgres.dump" ]]|| { echo "✗ missing postgres.dump" >&2; exit 1; }
[[ -f "$SNAPSHOT_DIR/storage.tar" ]]  || { echo "✗ missing storage.tar"  >&2; exit 1; }

docker ps --format '{{.Names}}' | grep -qx "$TARGET_DB" \
  || { echo "✗ target db container $TARGET_DB is not running" >&2; exit 1; }
docker ps --format '{{.Names}}' | grep -qx "$TARGET_STORAGE" \
  || { echo "✗ target storage container $TARGET_STORAGE is not running" >&2; exit 1; }

echo "→ restoring $SNAPSHOT_DIR into $TARGET_DB / $TARGET_STORAGE"

# ── 1. roles ────────────────────────────────────────────────────────────
# psql -v ON_ERROR_STOP=1 would abort on "role already exists"; we let it
# slide because every Supabase image creates its own admin roles up front.
echo "  ├ applying roles (errors for existing roles are expected)..."
docker exec -i "$TARGET_DB" psql -U postgres < "$SNAPSHOT_DIR/roles.sql" \
  2> >(grep -v 'already exists' >&2) || true

# ── 2. database ─────────────────────────────────────────────────────────
echo "  ├ restoring database..."
# --clean --if-exists drops existing tables/types before recreating, so we
# don't trip on partially-initialised state. --no-owner avoids errors when
# the target uses different role names than the source.
docker exec -i "$TARGET_DB" pg_restore \
  -U postgres \
  -d postgres \
  --clean --if-exists \
  --no-owner \
  --no-privileges \
  --no-comments \
  < "$SNAPSHOT_DIR/postgres.dump" \
  2> >(grep -v 'NOTICE\|does not exist, skipping\|already exists' >&2) || true

# ── 3. storage files ────────────────────────────────────────────────────
echo "  ├ unpacking storage files..."
docker exec -i "$TARGET_STORAGE" tar -xf - -C "$STORAGE_PATH_IN_CONTAINER" \
  < "$SNAPSHOT_DIR/storage.tar"

# ── verify ──────────────────────────────────────────────────────────────
echo "  ├ post-restore sanity..."
docker exec "$TARGET_DB" psql -U postgres -d postgres -tA -c "
  select 'public.' || relname || ': ' || n_live_tup
  from pg_stat_user_tables
  where schemaname = 'public'
  order by relname;
" | sed 's/^/    /'

echo "✓ restore complete"
echo
echo "  next: update apps/web/.env.local on this host to point at the"
echo "  new Supabase (URL, anon key, service role key). Existing"
echo "  MANTLE_MASTER_KEY and ALLOWED_USER_ID must remain unchanged."
