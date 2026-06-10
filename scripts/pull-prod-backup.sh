#!/usr/bin/env bash
# Offsite leg of the brain backup — runs ON the Mac (launchd, daily).
#
# Pulls from the prod VPS (ssh alias `mantle-prod`, read-only on prod):
#   1. backups/nightly/  → ~/Backups/mantle/prod/db/      (pg_dump archives)
#   2. data/files/       → ~/Backups/mantle/prod/files/   (host-mirrored files)
#   3. data/minio/       → ~/Backups/mantle/prod/minio/   (object bytes, raw xl)
# then verifies the newest dump with `pg_restore --list` (catches truncated /
# corrupt archives, not just transfer errors) and prunes local dumps older
# than RETAIN_DAYS.
#
# Deliberate choices:
#   - files/ and minio/ are mirrored WITHOUT --delete: a deletion on prod
#     (or a compromised prod) can never destroy the offsite copy. At ~100M
#     total, accumulation is a non-issue; the DB dumps carry history anyway.
#   - The minio mirror is a raw copy of the live xl backend. It restores onto
#     the SAME MinIO (put the dir back); for logical cross-server restore use
#     `mc mirror` (see docs/backups.md). Objects are content-addressed and
#     write-once, so a mid-write race at most catches one in-flight object —
#     the next night's pass heals it.
#   - .minio.sys internals are included on purpose: that's what makes the
#     raw-restore path work.
#
# Install (one-time):  bash scripts/pull-prod-backup.sh --install-launchd
# Status:              cat ~/Backups/mantle/prod/last-success
# Log:                 ~/Backups/mantle/prod/pull.log
set -euo pipefail

HOST="${MANTLE_PROD_HOST:-mantle-prod}"
DEST="${MANTLE_BACKUP_DIR:-$HOME/Backups/mantle/prod}"
RETAIN_DAYS="${MANTLE_BACKUP_RETAIN_DAYS:-30}"
PG_RESTORE="${PG_RESTORE:-/opt/homebrew/opt/libpq/bin/pg_restore}"
PLIST="$HOME/Library/LaunchAgents/me.schoeman.mantle-backup-pull.plist"

if [ "${1:-}" = "--install-launchd" ]; then
  mkdir -p "$(dirname "$PLIST")" "$DEST"
  SCRIPT="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>me.schoeman.mantle-backup-pull</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${SCRIPT}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>${DEST}/pull.log</string>
  <key>StandardErrorPath</key><string>${DEST}/pull.log</string>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "✔ launchd job installed (daily 08:15, missed runs fire on wake): $PLIST"
  exit 0
fi

mkdir -p "$DEST/db" "$DEST/files" "$DEST/minio"
echo "[$(date "+%Y-%m-%dT%H:%M:%S%z")] ▶ pulling prod backups from $HOST"

# 1. DB dumps — mirror of the VPS's rotated nightly dir. --delete is correct
#    HERE (and only here): the local prune below is what owns retention, and
#    *.part partials are excluded so we never copy a dump mid-write.
rsync -az --delete --exclude '*.part' --exclude 'backup.log' \
  "$HOST":'~/mantle/backups/nightly/' "$DEST/db/nightly-mirror/"
# Accumulate into db/ by date so retention outlives the VPS's 7-dump window.
for f in "$DEST"/db/nightly-mirror/mantle-*.dump; do
  [ -e "$f" ] || continue
  cp -n "$f" "$DEST/db/" 2>/dev/null || true
done

# 2 + 3. Files + object bytes (no --delete — see header).
rsync -az "$HOST":'~/mantle/data/files/' "$DEST/files/"
rsync -az "$HOST":'~/mantle/data/minio/' "$DEST/minio/"

# Verify the newest dump is a readable archive, not just present.
NEWEST="$(ls -t "$DEST"/db/mantle-*.dump 2>/dev/null | head -1 || true)"
if [ -z "$NEWEST" ]; then
  echo "[$(date "+%Y-%m-%dT%H:%M:%S%z")] ✗ no dumps present after pull — investigate" >&2
  exit 1
fi
if [ -x "$PG_RESTORE" ] || command -v "$PG_RESTORE" >/dev/null 2>&1; then
  if ! "$PG_RESTORE" --list "$NEWEST" >/dev/null; then
    echo "[$(date "+%Y-%m-%dT%H:%M:%S%z")] ✗ pg_restore --list FAILED for $NEWEST — dump unreadable" >&2
    exit 1
  fi
else
  # Fallback: verify inside the local dev pg container if it's running.
  if docker exec -i mantle_pg true 2>/dev/null; then
    docker cp "$NEWEST" mantle_pg:/tmp/verify.dump
    docker exec mantle_pg pg_restore --list /tmp/verify.dump >/dev/null
    docker exec mantle_pg rm -f /tmp/verify.dump
  else
    echo "[$(date "+%Y-%m-%dT%H:%M:%S%z")] ⚠ no pg_restore available — dump NOT verified" >&2
  fi
fi

# Prune local dumps past retention (the verified-newest is always kept).
find "$DEST/db" -maxdepth 1 -name 'mantle-*.dump' -mtime "+${RETAIN_DAYS}" ! -path "$NEWEST" -delete

COUNT="$(ls "$DEST"/db/mantle-*.dump 2>/dev/null | wc -l | tr -d ' ')"
SIZE="$(du -sh "$DEST" | cut -f1)"
date "+%Y-%m-%dT%H:%M:%S%z" > "$DEST/last-success"
echo "[$(date "+%Y-%m-%dT%H:%M:%S%z")] ✔ pull complete — ${COUNT} dump(s), ${SIZE} total, newest verified: $(basename "$NEWEST")"
