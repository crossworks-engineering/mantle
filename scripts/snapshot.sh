#!/usr/bin/env bash
# Take a complete, restorable snapshot of Mantle's Supabase data.
#
# What it captures:
#   - Postgres roles      → roles.sql       (pg_dumpall --roles-only)
#   - Postgres database   → postgres.dump   (pg_dump -Fc, custom binary format)
#   - Storage files       → storage.tar     (everything under the bucket root)
#   - Snapshot metadata   → meta.txt        (image versions, timestamp, host info)
#
# What it does NOT capture (must be managed separately):
#   - MANTLE_MASTER_KEY   → in apps/web/.env.local. Without it, the
#                           encrypted columns are unrecoverable bytes.
#   - GOOGLE_CLIENT_ID/SECRET, etc. → also env-only.
#
# Designed to be safe against a running Supabase:
#   - pg_dump takes a transactional snapshot; no need to stop Postgres.
#   - The storage tar is taken from a running container — a tiny window
#     exists where in-flight uploads could be missed. Pass --stop-storage
#     to halt storage during the tar for maximum consistency.
#
# Usage:
#   ./scripts/snapshot.sh                          # writes to backups/<timestamp>/
#   ./scripts/snapshot.sh ./my-backup              # writes to ./my-backup/
#   ./scripts/snapshot.sh --stop-storage           # safer storage capture
#
set -euo pipefail

DB_CONTAINER="${MANTLE_DB_CONTAINER:-supabase_db_mantle}"
STORAGE_CONTAINER="${MANTLE_STORAGE_CONTAINER:-supabase_storage_mantle}"
STORAGE_PATH_IN_CONTAINER="${MANTLE_STORAGE_PATH:-/mnt}"

STOP_STORAGE=0
OUT_DIR=""

for arg in "$@"; do
  case "$arg" in
    --stop-storage) STOP_STORAGE=1 ;;
    --help|-h)
      sed -n '2,/^set -euo/p' "$0" | sed -n '/^#/p' | sed 's/^# \?//'
      exit 0
      ;;
    *) OUT_DIR="$arg" ;;
  esac
done

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="backups/$(date +%Y%m%d-%H%M%S)"
fi

mkdir -p "$OUT_DIR"

# ── sanity: containers must be running ──────────────────────────────────
if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "✗ container $DB_CONTAINER is not running. Run 'supabase start' first." >&2
  exit 1
fi
if ! docker ps --format '{{.Names}}' | grep -qx "$STORAGE_CONTAINER"; then
  echo "✗ container $STORAGE_CONTAINER is not running." >&2
  exit 1
fi

echo "→ Capturing snapshot in $OUT_DIR"

# ── 1. roles ────────────────────────────────────────────────────────────
echo "  ├ dumping roles..."
docker exec "$DB_CONTAINER" pg_dumpall -U postgres --roles-only \
  > "$OUT_DIR/roles.sql"

# ── 2. postgres database (custom format — compressed, parallel-restorable) ─
echo "  ├ dumping database..."
docker exec "$DB_CONTAINER" pg_dump -U postgres -Fc -d postgres \
  > "$OUT_DIR/postgres.dump"

# ── 3. storage files ────────────────────────────────────────────────────
if (( STOP_STORAGE )); then
  echo "  ├ pausing storage container for consistent tar..."
  docker pause "$STORAGE_CONTAINER" >/dev/null
fi
echo "  ├ archiving storage files..."
docker exec "$STORAGE_CONTAINER" tar -cf - -C "$STORAGE_PATH_IN_CONTAINER" . \
  > "$OUT_DIR/storage.tar"
if (( STOP_STORAGE )); then
  docker unpause "$STORAGE_CONTAINER" >/dev/null
fi

# ── 4. snapshot metadata ────────────────────────────────────────────────
# Real `count(*)` rather than `pg_stat_user_tables.n_live_tup`: the latter
# is a stat that can lag arbitrarily on tables with few writes. We want
# the numbers in meta.txt to be the ground truth a restore can be
# compared against.
{
  echo "snapshot_taken_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host: $(uname -a)"
  echo "db_image: $(docker inspect --format '{{.Config.Image}}' "$DB_CONTAINER")"
  echo "storage_image: $(docker inspect --format '{{.Config.Image}}' "$STORAGE_CONTAINER")"
  echo "postgres_version: $(docker exec "$DB_CONTAINER" psql -U postgres -tA -c 'select version()' | head -1)"
  echo
  echo "── row counts ──"
  docker exec "$DB_CONTAINER" psql -U postgres -d postgres -tAc "
    select string_agg(line, e'\n' order by line) from (
      select 'public.' || tablename || ': ' ||
        (xpath('/row/c/text()',
          query_to_xml(format('select count(*) as c from public.%I', tablename), true, true, '')))[1]::text as line
      from pg_tables where schemaname = 'public'
    ) t;
  "
  echo "auth.users: $(docker exec "$DB_CONTAINER" psql -U postgres -tA -c 'select count(*) from auth.users')"
} > "$OUT_DIR/meta.txt"

# ── done ────────────────────────────────────────────────────────────────
SIZE=$(du -sh "$OUT_DIR" | cut -f1)
echo "✓ snapshot complete — $SIZE"
echo
echo "  contents:"
ls -lh "$OUT_DIR" | tail -n +2 | sed 's/^/    /'
echo
echo "  to restore:"
echo "    ./scripts/restore.sh $OUT_DIR <target-DATABASE_URL>"
