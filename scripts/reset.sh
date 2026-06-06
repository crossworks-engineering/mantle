#!/usr/bin/env bash
# Wipe the dev brain and rebuild from scratch — one command for "I want to
# start over." Asks for explicit confirmation (volume deletion is irreversible),
# takes a backup first (in case you want anything back), then runs the full
# bring-up via up.sh.
#
# What it does NOT touch: apps/web/.env.local (your keys), the host filesystem,
# the production stack, or any other docker-compose project.

set -euo pipefail
cd "$(dirname "$0")/.."

cat <<'EOF'

──────────────────────────────────────────────────────────────────────
  Mantle dev reset
──────────────────────────────────────────────────────────────────────

This will:
  • Take a backup of the current dev brain (→ backups/mantle-<ts>.dump)
  • Stop + remove the dev containers (mantle_pg, mantle_minio, mantle_tika)
  • DELETE the postgres + minio volumes
    (your dev brain, uploads, embeddings cache — all gone)
  • Re-run `pnpm start` (infra → bucket → migrate → pg-boss → dev servers)

What it KEEPS:
  • apps/web/.env.local (your API keys, master key)
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
if docker ps --filter "name=mantle_pg" --filter "status=running" --format '{{.Names}}' \
   | grep -q '^mantle_pg$'; then
  bash scripts/db-dump.sh
else
  echo "  (skipped — postgres container not running)"
fi

# ── 2. Tear down + wipe volumes --------------------------------------------
echo
echo "→ Tearing down dev infra + removing volumes…"
docker compose -f docker-compose.dev.yml down -v

# ── 3. Clear the stale owner pin in .env.local -----------------------------
# After a wipe, ALLOWED_USER_ID points at a user that no longer exists, which
# would silently pin every worker to a ghost. Comment it out so waitForOwner
# adopts the fresh signup automatically.
if grep -qE '^ALLOWED_USER_ID=' apps/web/.env.local 2>/dev/null; then
  echo "→ Commenting out ALLOWED_USER_ID in apps/web/.env.local…"
  # Use a tempfile (portable sed -i across BSD/GNU)
  tmp="$(mktemp)"
  sed 's/^ALLOWED_USER_ID=/# ALLOWED_USER_ID (cleared by reset, fresh signup becomes owner) =/' \
    apps/web/.env.local > "$tmp" && mv "$tmp" apps/web/.env.local
  echo "  (re-pin to the new uuid after onboarding if you want stable restarts)"
fi

# ── 4. Bring everything back up via the canonical path ---------------------
echo
echo "→ Bringing fresh stack up via pnpm start…"
echo
exec bash scripts/up.sh
