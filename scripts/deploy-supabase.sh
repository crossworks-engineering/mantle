#!/usr/bin/env bash
# Push the Mantle Supabase stack to the remote server.
#
# What it does (idempotent — safe to re-run):
#   1. Verifies you have a fresh local snapshot to fall back on.
#   2. Stops the local Supabase CLI so bind-mount data is consistent.
#   3. rsyncs infra/supabase/ (compose, Caddyfile, kong config) to the server.
#   4. rsyncs infra/supabase/volumes/ — the actual data, after the
#      Postgres-down step above.
#   5. Reminds you to fill in the server's .env before bringing the
#      stack up.
#
# What it does NOT do:
#   - Generate or upload the server-side .env (you fill that in once).
#   - Run `docker compose up` on the server (you do that after the .env).
#   - Restart the local Supabase CLI (you don't need it; local dev points
#     at the remote via SSH tunnel from this point on).
#
# Usage:
#   ./scripts/deploy-supabase.sh
#
set -euo pipefail

HOST="${MANTLE_SSH_HOST:-cwe@mcp.crossworks.network}"
REMOTE_ROOT="${MANTLE_REMOTE_ROOT:-/home/cwe/mcp.cwe.cloud}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ deploying to ${HOST}:${REMOTE_ROOT}"

# ── 0. snapshot safety net ──────────────────────────────────────────────
RECENT_SNAPSHOT=$(find "$REPO_ROOT/backups" -maxdepth 1 -type d -mtime -1 2>/dev/null \
  | grep -v '^'"$REPO_ROOT/backups"'$' | head -1)
if [[ -z "$RECENT_SNAPSHOT" ]]; then
  echo "✗ No snapshot from the last 24 hours found." >&2
  echo "  Run ./scripts/snapshot.sh first — that's your rollback if the" >&2
  echo "  rsync goes sideways." >&2
  exit 1
fi
echo "✓ recent snapshot: $(basename "$RECENT_SNAPSHOT")"

# ── 1. drain local Supabase ─────────────────────────────────────────────
if docker ps --format '{{.Names}}' | grep -q '^supabase_db_mantle$'; then
  echo "→ stopping local Supabase (so bind-mounted data is consistent)..."
  supabase stop >/dev/null
fi

# ── 2. make sure the remote root exists ─────────────────────────────────
echo "→ ensuring remote tree exists..."
ssh "$HOST" "mkdir -p '${REMOTE_ROOT}/infra/supabase/volumes/db' \
                       '${REMOTE_ROOT}/infra/supabase/volumes/storage'"

# ── 3. push compose + caddy + kong configs (small, fast) ────────────────
echo "→ rsyncing compose + Caddyfile + kong config..."
rsync -avz --delete \
  --exclude '.env' \
  --exclude 'volumes/' \
  "$REPO_ROOT/infra/supabase/" \
  "${HOST}:${REMOTE_ROOT}/infra/supabase/"

# ── 4. push the data volumes ────────────────────────────────────────────
echo "→ rsyncing database (this is the big one)..."
rsync -avz --delete \
  "$REPO_ROOT/infra/supabase/volumes/db/" \
  "${HOST}:${REMOTE_ROOT}/infra/supabase/volumes/db/"

echo "→ rsyncing storage objects..."
rsync -avz --delete \
  "$REPO_ROOT/infra/supabase/volumes/storage/" \
  "${HOST}:${REMOTE_ROOT}/infra/supabase/volumes/storage/"

# ── 5. instructions for the human ───────────────────────────────────────
cat <<EOF

✓ files in place on ${HOST}.

NEXT (run on the server):

  ssh ${HOST}
  cd ${REMOTE_ROOT}/infra/supabase
  [ -f .env ] || cp .env.example .env       # only on first deploy
  \$EDITOR .env                              # fill in POSTGRES_PASSWORD,
                                            # JWT_SECRET, ANON_KEY,
                                            # SERVICE_ROLE_KEY, DASHBOARD_PASSWORD
  docker compose up -d
  docker compose logs -f caddy              # watch for the cert acquisition

When Caddy logs "certificate obtained successfully", open:

  https://mcp.crossworks.network/          (Studio basic-auth prompt)

then on the laptop:

  ./scripts/dev-tunnel.sh --background     # forward 127.0.0.1:54322 → server
  # Update apps/web/.env.local — see infra/supabase/README.md
  pnpm dev

EOF
