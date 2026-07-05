#!/usr/bin/env bash
# Restore per-app SQLite snapshots (from db-dump.sh's mantle-app-dbs-<ts>.tgz)
# into the app-dbs volume. Each snapshot is a COMPLETE SQLite database (VACUUM
# INTO output), so restore is a straight extract into APP_DB_DIR — the exact
# <owner>/<app>.sqlite paths the `app_databases` registry rows already point at.
#
# Order when moving/rebuilding a box:
#   1. Restore Postgres first (scripts/db-restore.sh) so the registry rows exist.
#   2. docker compose up -d --wait
#   3. scripts/app-dbs-restore.sh backups/mantle-app-dbs-<ts>.tgz
# Run it with apps idle (right after `up`, before heavy use) so it isn't racing
# a live writer on the same files.
set -euo pipefail
cd "$(dirname "$0")/.."

TGZ="${1:?usage: scripts/app-dbs-restore.sh <path-to-app-dbs.tgz>}"
[ -f "$TGZ" ] || { echo "✗ no such archive: $TGZ" >&2; exit 1; }

running() { docker ps --filter "name=$1" --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }
pick_app() {
  if [ -n "${MANTLE_APP_CONTAINER:-}" ]; then echo "$MANTLE_APP_CONTAINER"; return; fi
  if running mantle_web && running mantle_dev_web; then
    echo "✗ both mantle_web and mantle_dev_web are running — set MANTLE_APP_CONTAINER to pick one." >&2
    return 1
  fi
  if running mantle_dev_web; then echo mantle_dev_web; else echo mantle_web; fi
}
APP_CONTAINER="$(pick_app)"

if ! running "$APP_CONTAINER"; then
  echo "✗ app container '$APP_CONTAINER' not running — 'docker compose up -d --wait' first." >&2
  exit 1
fi

# Extract into the container's APP_DB_DIR (=/data/app-dbs), which is the mounted
# host volume — so the files land exactly where the registry expects them.
echo "▶ Restoring app SQLite snapshots from $TGZ → $APP_CONTAINER:/data/app-dbs"
docker exec -i "$APP_CONTAINER" sh -c 'mkdir -p /data/app-dbs && tar -C /data/app-dbs -xzf -' < "$TGZ"
echo "✔ Restored. (Restore the Postgres dump first if you haven't — the registry rows point at these files.)"
