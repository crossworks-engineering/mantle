#!/usr/bin/env bash
# Dump the running Mantle Postgres to a custom-format archive under ./backups.
# Custom format (-Fc) → restore with scripts/db-restore.sh (pg_restore).
#
# Usage:   scripts/db-dump.sh            # dumps mantle_pg → backups/mantle-<ts>.dump
#          MANTLE_PG_CONTAINER=other scripts/db-dump.sh
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER="${MANTLE_PG_CONTAINER:-mantle_pg}"
mkdir -p backups
TS="$(date +%Y%m%d-%H%M%S)"
OUT="backups/mantle-${TS}.dump"

if ! docker exec "$CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
  echo "✗ postgres container '$CONTAINER' not reachable — is the stack up?" >&2
  exit 1
fi

echo "▶ Dumping '$CONTAINER' (postgres/postgres) → $OUT"
# --no-owner keeps the dump portable across roles. Custom format is compressed.
docker exec "$CONTAINER" pg_dump -U postgres -d postgres -Fc --no-owner > "$OUT"

echo "✔ Wrote $(du -h "$OUT" | cut -f1) → $OUT"
echo "  Restore on the target with:  scripts/db-restore.sh $OUT"
