#!/usr/bin/env bash
# Roundtrip-test a snapshot by restoring it into a throwaway Postgres
# container and verifying key counts match the source.
#
# Does NOT test storage restore (would require booting a Supabase
# storage-api container — overkill for this validation). It does verify
# that the database half is fully restorable.
#
# Usage:
#   ./scripts/test-snapshot.sh <snapshot-dir>
#
set -euo pipefail

SNAPSHOT_DIR="${1:?usage: test-snapshot.sh <snapshot-dir>}"
TEMP_CONTAINER="mantle_snapshot_test_$$"

[[ -d "$SNAPSHOT_DIR" ]] || { echo "✗ snapshot dir not found" >&2; exit 1; }

cleanup() {
  echo "  ├ cleaning up $TEMP_CONTAINER..."
  docker rm -f "$TEMP_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "→ booting throwaway Postgres..."
# pgvector/pgvector:pg17 = upstream postgres:17 + vector extension. We
# add ltree + pgcrypto manually below (both ship in contrib). This is
# lighter than booting Supabase's full Postgres image, which carries
# extra bootstrap (auth schema event triggers, JWT secrets) that fight
# with pg_restore. We're only verifying the dump is structurally
# restorable — production restores happen into a real Supabase image.
docker run -d --name "$TEMP_CONTAINER" \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=postgres \
  pgvector/pgvector:pg17 >/dev/null

# Wait for ready (pg_isready loop, bounded).
for i in {1..30}; do
  if docker exec "$TEMP_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "  ├ creating Supabase-shaped extensions schema..."
# The dump expects `extensions` schema to exist (Supabase convention).
# Without this, CREATE EXTENSION ... WITH SCHEMA extensions fails.
docker exec "$TEMP_CONTAINER" psql -U postgres -d postgres -c "
  CREATE SCHEMA IF NOT EXISTS extensions;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE SCHEMA IF NOT EXISTS storage;
" >/dev/null

echo "  ├ restoring roles..."
docker exec -i "$TEMP_CONTAINER" psql -U postgres < "$SNAPSHOT_DIR/roles.sql" \
  2> >(grep -v 'already exists\|cannot drop\|must be member of' >&2) || true

echo "  ├ restoring database..."
docker exec -i "$TEMP_CONTAINER" pg_restore \
  -U postgres -d postgres \
  --clean --if-exists --no-owner --no-privileges --no-comments \
  < "$SNAPSHOT_DIR/postgres.dump" \
  2> >(grep -v 'NOTICE\|does not exist, skipping\|already exists\|role.*does not exist' >&2) || true

echo "  ├ verifying row counts..."
EXPECTED=$(grep -E '^public\.' "$SNAPSHOT_DIR/meta.txt" || true)
ACTUAL=$(docker exec "$TEMP_CONTAINER" psql -U postgres -d postgres -tAc "
  select string_agg(line, e'\n' order by line) from (
    select 'public.' || tablename || ': ' ||
      (xpath('/row/c/text()',
        query_to_xml(format('select count(*) as c from public.%I', tablename), true, true, '')))[1]::text as line
    from pg_tables where schemaname = 'public'
  ) t;
")

echo
echo "  source (from meta.txt):"
echo "$EXPECTED" | sed 's/^/    /'
echo
echo "  restored:"
echo "$ACTUAL" | sed 's/^/    /'

# Critical: at least one approved sender survived
APPROVED=$(docker exec "$TEMP_CONTAINER" psql -U postgres -d postgres -tA -c \
  "select count(*) from email_senders where status='approved'" 2>/dev/null || echo "0")
echo
echo "  approved senders restored: $APPROVED"

if [[ "$EXPECTED" == "$ACTUAL" ]]; then
  echo
  echo "✓ roundtrip clean — row counts match"
else
  echo
  echo "⚠ row counts differ between source and restored. Inspect manually."
  exit 1
fi
