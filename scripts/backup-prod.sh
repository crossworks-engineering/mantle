#!/usr/bin/env bash
# Nightly brain backup — runs ON the prod VPS from cron.
#
# Dumps Postgres (custom format, compressed) into backups/nightly/ and prunes
# that directory to the newest KEEP dumps. Object bytes (data/minio) and host
# files (data/files) need no dump step — they're bind-mounted plain files,
# mirrored offsite by the Mac-side pull (scripts/pull-prod-backup.sh).
#
# Manual dumps written by scripts/db-dump.sh land in backups/ (the parent) and
# are NEVER touched by this rotation — only backups/nightly/ is pruned.
#
# Install (crontab -e on the VPS, runs 02:30 server time):
#   30 2 * * * cd $HOME/mantle && bash scripts/backup-prod.sh >> backups/nightly/backup.log 2>&1
#
# See docs/backups.md for the full design + restore drill.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER="${MANTLE_PG_CONTAINER:-mantle_pg}"
KEEP="${MANTLE_BACKUP_KEEP:-7}"
DIR="backups/nightly"
mkdir -p "$DIR"

TS="$(date +%Y%m%d-%H%M%S)"
OUT="$DIR/mantle-${TS}.dump"

if ! docker exec "$CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
  echo "[$(date -Is)] ✗ postgres container '$CONTAINER' not reachable — no dump written" >&2
  exit 1
fi

# --no-owner keeps the dump portable across roles. Write to a temp name and
# move into place so a partial dump (disk full, container restart) can never
# be mistaken for a good one by the rotation or the offsite pull.
docker exec "$CONTAINER" pg_dump -U postgres -d postgres -Fc --no-owner > "${OUT}.part"
mv "${OUT}.part" "$OUT"

# Sanity: a custom-format dump starts with the magic bytes "PGDMP".
if [ "$(head -c5 "$OUT")" != "PGDMP" ]; then
  echo "[$(date -Is)] ✗ $OUT is not a valid pg_dump archive — keeping for inspection, exiting" >&2
  exit 1
fi

# Rotate: keep the newest $KEEP nightly dumps. ls -t is safe here — names are
# our own timestamped pattern, no spaces.
ls -t "$DIR"/mantle-*.dump 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
  rm -f "$old"
done

COUNT="$(ls "$DIR"/mantle-*.dump 2>/dev/null | wc -l | tr -d ' ')"
echo "[$(date -Is)] ✔ $(du -h "$OUT" | cut -f1) → $OUT (${COUNT} nightly dump(s) retained)"
