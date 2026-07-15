#!/usr/bin/env bash
# Back up the running Mantle stack under ./backups — ALL THREE halves of its state:
#   1. Postgres     → backups/mantle-<ts>.dump           (pg_dump -Fc; restore: db-restore.sh)
#   2. App SQLite   → backups/mantle-app-dbs-<ts>.tgz    (per-app /apps databases;
#      restore: app-dbs-restore.sh). These live on a SEPARATE volume from
#      Postgres, so pg_dump alone would silently miss them.
#   3. Table SQLite → backups/mantle-table-dbs-<ts>.tgz  (sqlite-native table
#      workbooks under TABLE_DB_DIR; restore: untar into ${MANTLE_DATA_DIR}/table-dbs —
#      the archive mirrors the live <owner>/<node>.sqlite layout).
#
# Usage:   scripts/db-dump.sh
#          MANTLE_PG_CONTAINER=other  MANTLE_APP_CONTAINER=other  scripts/db-dump.sh
set -euo pipefail
cd "$(dirname "$0")/.."

running() { docker ps --filter "name=$1" --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }

# Runs both on dev machines (container `mantle_dev_pg` since the dev compose
# got its own project) and on deployed boxes (prod compose keeps `mantle_pg`).
# Explicit MANTLE_PG_CONTAINER wins; otherwise use whichever is running, and
# refuse to guess when both are (a dev checkout on a box with a live stack).
pick() { # pick <prod-name> <dev-name> <label> <override>
  if [ -n "$4" ]; then echo "$4"; return; fi
  if running "$1" && running "$2"; then
    echo "✗ both $1 and $2 are running — set the $3 override to pick one." >&2
    return 1
  fi
  if running "$2"; then echo "$2"; else echo "$1"; fi
}
CONTAINER="$(pick mantle_pg mantle_dev_pg MANTLE_PG_CONTAINER "${MANTLE_PG_CONTAINER:-}")"
APP_CONTAINER="$(pick mantle_web mantle_dev_web MANTLE_APP_CONTAINER "${MANTLE_APP_CONTAINER:-}")"
mkdir -p backups
TS="$(date +%Y%m%d-%H%M%S)"
OUT="backups/mantle-${TS}.dump"
APPDB_OUT="backups/mantle-app-dbs-${TS}.tgz"

if ! docker exec "$CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
  echo "✗ postgres container '$CONTAINER' not reachable — is the stack up?" >&2
  exit 1
fi

echo "▶ Dumping '$CONTAINER' (postgres/postgres) → $OUT"
# --no-owner keeps the dump portable across roles. Custom format is compressed.
docker exec "$CONTAINER" pg_dump -U postgres -d postgres -Fc --no-owner > "$OUT"
echo "✔ Wrote $(du -h "$OUT" | cut -f1) → $OUT"

# --- Per-app SQLite ---------------------------------------------------------
# Snapshot each app DB with VACUUM INTO (consistent even under concurrent
# writes) inside the app container, then tar the snapshots to the host. Loud on
# failure but NON-fatal: a hiccup here must not invalidate the Postgres dump —
# but it must never be silent (that silence is the durability gap we're closing).
# A box that has never built a mini-app has no app-db dir inside the container
# (fresh install, or a compose predating the app-dbs mount) — that's "nothing
# to back up yet", not a failure, so probe before snapshotting.
if ! running "$APP_CONTAINER"; then
  echo "⚠ app container '$APP_CONTAINER' not running — per-app SQLite NOT backed up." >&2
  echo "  Set MANTLE_APP_CONTAINER if it has a different name." >&2
elif ! docker exec "$APP_CONTAINER" sh -c 'test -d "${APP_DB_DIR:-/data/app-dbs}"'; then
  echo "▷ no app databases yet in '$APP_CONTAINER' — skipping per-app SQLite."
else
  echo "▶ Snapshotting per-app SQLite via '$APP_CONTAINER' → $APPDB_OUT"
  if docker exec "$APP_CONTAINER" sh -c '
        set -e
        rm -rf /tmp/appdbsnap && mkdir -p /tmp/appdbsnap
        pnpm -C apps/web exec tsx scripts/backup-app-dbs.ts /tmp/appdbsnap 1>&2
        tar -C /tmp/appdbsnap -czf - .
      ' > "$APPDB_OUT"; then
    docker exec "$APP_CONTAINER" rm -rf /tmp/appdbsnap >/dev/null 2>&1 || true
    echo "✔ Wrote $(du -h "$APPDB_OUT" | cut -f1) → $APPDB_OUT"
    echo "  Restore app data with:  scripts/app-dbs-restore.sh $APPDB_OUT"
  else
    rm -f "$APPDB_OUT"
    echo "⚠ app-db snapshot FAILED — per-app SQLite NOT backed up (Postgres dump is intact)." >&2
    echo "  See the output above; re-run once the app container is healthy." >&2
  fi
fi

# --- Sqlite-native table workbooks -------------------------------------------
# Same contract as the app-dbs half: VACUUM INTO snapshots inside the app
# container (consistent under concurrent writes), tarred to the host. Loud but
# non-fatal; a box with no table-dbs dir yet (no compose refresh, or no
# file-backed tables) is "nothing to back up", not a failure.
TABLEDB_OUT="backups/mantle-table-dbs-${TS}.tgz"
if ! running "$APP_CONTAINER"; then
  echo "⚠ app container '$APP_CONTAINER' not running — table workbooks NOT backed up." >&2
elif ! docker exec "$APP_CONTAINER" sh -c 'test -d "${TABLE_DB_DIR:-/data/table-dbs}"'; then
  echo "▷ no table workbooks yet in '$APP_CONTAINER' — skipping table SQLite."
else
  echo "▶ Snapshotting table workbooks via '$APP_CONTAINER' → $TABLEDB_OUT"
  if docker exec "$APP_CONTAINER" sh -c '
        set -e
        rm -rf /tmp/tabledbsnap && mkdir -p /tmp/tabledbsnap
        pnpm -C apps/web exec tsx scripts/backup-table-dbs.ts /tmp/tabledbsnap 1>&2
        tar -C /tmp/tabledbsnap -czf - .
      ' > "$TABLEDB_OUT"; then
    docker exec "$APP_CONTAINER" rm -rf /tmp/tabledbsnap >/dev/null 2>&1 || true
    echo "✔ Wrote $(du -h "$TABLEDB_OUT" | cut -f1) → $TABLEDB_OUT"
    echo "  Restore table data by untarring into \${MANTLE_DATA_DIR}/table-dbs"
  else
    rm -f "$TABLEDB_OUT"
    echo "⚠ table-db snapshot FAILED — table workbooks NOT backed up (Postgres dump is intact)." >&2
  fi
fi

echo "  Restore Postgres with:  scripts/db-restore.sh $OUT"
