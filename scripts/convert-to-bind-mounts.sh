#!/usr/bin/env bash
# Relocate Supabase Docker volumes onto host bind-mount paths so the data
# lives in plain files under `infra/supabase/volumes/`. The Supabase CLI
# keeps using its existing volume names — it doesn't know the difference.
#
# Why: lets you rsync `infra/supabase/volumes/` to a server for migration,
# back it up with restic / borg / tar, inspect the on-disk state, and run
# `docker compose` against the same paths if/when you outgrow the CLI.
#
# Idempotent? No — this is a one-time, destructive-to-old-volumes
# conversion. Take a snapshot first (./scripts/snapshot.sh); the script
# refuses to run without one in the last 24 hours.
#
# Reversible? Yes, but manually: snapshot first → revert by removing the
# bind-mount volumes and letting `supabase start` recreate the defaults,
# then restore from snapshot. Hence the safety-net snapshot requirement.
#
set -euo pipefail

# Volume names that the Supabase CLI uses (project_id=mantle in config.toml).
VOLUMES=(
  supabase_db_mantle
  supabase_storage_mantle
)

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIND_ROOT="$REPO_ROOT/infra/supabase/volumes"

# ── safety: insist on a recent snapshot ─────────────────────────────────
RECENT_SNAPSHOT=$(find "$REPO_ROOT/backups" -maxdepth 1 -type d -mtime -1 2>/dev/null \
  | grep -v '^'"$REPO_ROOT/backups"'$' | head -1)
if [[ -z "$RECENT_SNAPSHOT" ]]; then
  echo "✗ No snapshot from the last 24 hours found in backups/. Run:" >&2
  echo "    ./scripts/snapshot.sh" >&2
  echo "  then re-run this script." >&2
  exit 1
fi
echo "✓ recent snapshot present: $(basename "$RECENT_SNAPSHOT")"

# ── safety: Supabase must be stopped (volumes can't be detached if in use) ─
if docker ps --format '{{.Names}}' | grep -q '^supabase_db_mantle$'; then
  echo "✗ Supabase is running. Stop it first:" >&2
  echo "    supabase stop" >&2
  exit 1
fi

# ── confirm with the user ───────────────────────────────────────────────
cat <<EOF

About to relocate these Docker volumes onto host paths:

  supabase_db_mantle      → $BIND_ROOT/db/
  supabase_storage_mantle → $BIND_ROOT/storage/

Sequence per volume:
  1. mkdir -p the bind path
  2. copy volume contents → bind path (with verification)
  3. remove the old named volume
  4. recreate the volume as a bind alias to the path

After this, 'supabase start' uses the bind-mounted data transparently.

EOF
read -rp "Proceed? [y/N] " yn
if [[ "$yn" != "y" && "$yn" != "Y" ]]; then
  echo "aborted."
  exit 0
fi

# ── per-volume conversion ───────────────────────────────────────────────
for VOL in "${VOLUMES[@]}"; do
  SUFFIX="${VOL#supabase_}"     # db_mantle → db_mantle
  SUFFIX="${SUFFIX%_mantle}"    # db_mantle → db
  HOST_PATH="$BIND_ROOT/$SUFFIX"

  echo
  echo "── $VOL → $HOST_PATH"

  if ! docker volume inspect "$VOL" >/dev/null 2>&1; then
    echo "  ⚠ volume $VOL doesn't exist; skipping"
    continue
  fi

  # If already a bind to our path, skip (script is idempotent in that sense).
  EXISTING_DEVICE=$(docker volume inspect "$VOL" \
    --format '{{index .Options "device"}}' 2>/dev/null || echo "")
  if [[ "$EXISTING_DEVICE" == "$HOST_PATH" ]]; then
    echo "  ✓ already bind-mounted to $HOST_PATH; nothing to do"
    continue
  fi

  mkdir -p "$HOST_PATH"
  if [[ -n "$(ls -A "$HOST_PATH" 2>/dev/null)" ]]; then
    echo "  ✗ $HOST_PATH is not empty. Move or remove its contents first." >&2
    exit 1
  fi

  # 1. copy from old volume into bind path, with a file-count sanity check
  echo "  ├ copying contents..."
  SRC_COUNT=$(docker run --rm -v "$VOL:/from:ro" alpine:3 \
    sh -c 'find /from -type f | wc -l' | tr -d ' ')
  docker run --rm \
    -v "$VOL:/from:ro" \
    -v "$HOST_PATH:/to" \
    alpine:3 sh -c 'cp -a /from/. /to/'
  DST_COUNT=$(find "$HOST_PATH" -type f | wc -l | tr -d ' ')
  echo "    source: $SRC_COUNT files   dest: $DST_COUNT files"
  if [[ "$SRC_COUNT" != "$DST_COUNT" ]]; then
    echo "  ✗ file count mismatch — aborting before destroying source volume" >&2
    echo "    (the snapshot in backups/ is your recovery path)" >&2
    exit 1
  fi

  # 3. remove old named volume
  echo "  ├ removing original volume..."
  docker volume rm "$VOL" >/dev/null

  # 4. recreate as bind alias
  echo "  ├ recreating $VOL as bind alias..."
  docker volume create \
    --driver local \
    --opt type=none \
    --opt device="$HOST_PATH" \
    --opt o=bind \
    "$VOL" >/dev/null

  echo "  ✓ $VOL is now backed by $HOST_PATH"
done

cat <<EOF

✓ conversion complete.

Next steps:

  supabase start           # CLI starts as usual; data is on bind-mounts
  cd /Users/jasonschoeman/Projects/mantle && pnpm dev

Verify (in Studio or psql) that your senders / emails / accounts
are intact before deleting any snapshots.

For future migration to a server:

  supabase stop
  rsync -avz infra/supabase/volumes/ user@server:/srv/mantle/supabase/volumes/
  # on server: bring up matching Supabase against those paths

EOF
