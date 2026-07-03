#!/usr/bin/env bash
# Dump the running Mantle Postgres to a custom-format archive under ./backups.
# Custom format (-Fc) → restore with scripts/db-restore.sh (pg_restore).
#
# Usage:   scripts/db-dump.sh            # dumps the running postgres → backups/mantle-<ts>.dump
#          MANTLE_PG_CONTAINER=other scripts/db-dump.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# Runs both on dev machines (container `mantle_dev_pg` since the dev compose
# got its own project) and on deployed boxes (prod compose keeps `mantle_pg`).
# Explicit MANTLE_PG_CONTAINER wins; otherwise use whichever is running, and
# refuse to guess when both are (a dev checkout on a box with a live stack).
pick_pg() {
  running() { docker ps --filter "name=$1" --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }
  if running mantle_pg && running mantle_dev_pg; then
    echo "✗ both mantle_pg and mantle_dev_pg are running — set MANTLE_PG_CONTAINER to pick one." >&2
    return 1
  fi
  if running mantle_dev_pg; then echo mantle_dev_pg; else echo mantle_pg; fi
}
CONTAINER="${MANTLE_PG_CONTAINER:-$(pick_pg)}"
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
