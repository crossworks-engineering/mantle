#!/usr/bin/env bash
# Wipe the dev brain and rebuild from scratch — one command for "I want to
# start over." Asks for explicit confirmation (data deletion is irreversible),
# takes a backup first (in case you want anything back), then runs the full
# bring-up via up.sh.
#
# What it does NOT touch: server/web/.env.local (your keys), the host filesystem
# outside ${MANTLE_DATA_DIR:-./data}/{postgres,minio}, the production stack, or
# any other docker-compose project.

set -euo pipefail
cd "$(dirname "$0")/.."

# Resolve the data dir the same way compose does: shell env wins, then the
# root .env (compose reads it for ${VAR} substitution), then ./data.
if [[ -z "${MANTLE_DATA_DIR:-}" && -f .env ]]; then
  MANTLE_DATA_DIR="$(grep -E '^MANTLE_DATA_DIR=' .env | tail -1 | cut -d= -f2- || true)"
fi
DATA_DIR="${MANTLE_DATA_DIR:-./data}"

cat <<EOF

──────────────────────────────────────────────────────────────────────
  Mantle dev reset
──────────────────────────────────────────────────────────────────────

This will:
  • Take a backup of the current dev brain (→ backups/mantle-<ts>.dump)
  • Stop + remove the dev containers (mantle_dev_pg, mantle_dev_minio, mantle_dev_tika)
  • DELETE the bind-mounted data dirs $DATA_DIR/{postgres,minio}
    (your dev brain, uploads, embeddings cache — all gone)
  • Re-run \`pnpm start\` (infra → bucket → migrate → pg-boss → dev servers)

What it KEEPS:
  • server/web/.env.local (your API keys, master key)
  • MANTLE_FILES_ROOT (the /files disk mirror), if you've set one —
    delete it yourself for a truly blank slate
  • production data and containers (untouched)
  • the source tree

EOF

read -rp "Type 'wipe' to confirm: " confirm
if [[ "${confirm:-}" != "wipe" ]]; then
  echo "Aborted. Nothing changed."
  exit 1
fi

# ── 1. Best-effort backup --------------------------------------------------
echo
echo "→ Backing up current dev brain (best-effort)…"
if docker ps --filter "name=mantle_dev_pg" --filter "status=running" --format '{{.Names}}' \
   | grep -q '^mantle_dev_pg$'; then
  MANTLE_PG_CONTAINER=mantle_dev_pg bash scripts/db-dump.sh
else
  echo "  (skipped — postgres container not running)"
fi

# ── 2. Tear down + wipe data ------------------------------------------------
echo
echo "→ Tearing down dev infra…"
docker compose -f docker-compose.dev.yml down -v

# The postgres + minio data are BIND MOUNTS (not named volumes) since v0.103,
# so `down -v` does NOT delete them — remove the dirs explicitly. Do it from a
# container: on Linux the postgres files are owned by the container's uid and
# a plain rm would need sudo.
if [[ -d "$DATA_DIR" ]]; then
  ABS_DATA_DIR="$(cd "$DATA_DIR" && pwd)"
  echo "→ Deleting bind-mounted data ($ABS_DATA_DIR/{postgres,minio})…"
  docker run --rm -v "$ABS_DATA_DIR:/wipe" alpine \
    rm -rf /wipe/postgres /wipe/minio
else
  echo "→ No data dir at $DATA_DIR — nothing to delete."
fi

# ── 3. Clear the stale owner pin in .env.local -----------------------------
# After a wipe, ALLOWED_USER_ID points at a user that no longer exists, which
# would silently pin every worker to a ghost. Comment it out so waitForOwner
# adopts the fresh signup automatically.
if grep -qE '^ALLOWED_USER_ID=' server/web/.env.local 2>/dev/null; then
  echo "→ Commenting out ALLOWED_USER_ID in server/web/.env.local…"
  # Use a tempfile (portable sed -i across BSD/GNU)
  tmp="$(mktemp)"
  sed 's/^ALLOWED_USER_ID=/# ALLOWED_USER_ID (cleared by reset, fresh signup becomes owner) =/' \
    server/web/.env.local > "$tmp" && mv "$tmp" server/web/.env.local
  echo "  (re-pin to the new uuid after onboarding if you want stable restarts)"
fi

# ── 4. Bring everything back up via the canonical path ---------------------
echo
echo "→ Bringing fresh stack up via pnpm start…"
echo
exec bash scripts/up.sh
