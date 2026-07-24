#!/usr/bin/env bash
# Run ONLY the owner-UI frontend (client/web), detached from any local backend —
# no Docker, no Postgres, no workers. The browser talks straight to a deployed
# Mantle's HTTP API (docs/db-less-dev.md).
#
# Invoke via `pnpm dev:fe`. Extra args pass through to `next dev`
# (e.g. `pnpm dev:fe --port 3001`).
#
# Since the member carve the client app is zero-secret and ALWAYS talks to the
# server named by MANTLE_SERVER_ORIGIN — "detached" is simply pointing that at
# a remote brain. Sign in on the login page with that brain's credentials (the
# client mints and stores its bearer itself; no local token config needed).
#
# Config lives in client/web/.env.detached.local (git-ignored):
#
#   MANTLE_REMOTE=https://test.crossworks.network
#
# Prerequisite ON THE REMOTE: this dev origin must be CORS-allowlisted —
# MANTLE_API_CORS_ORIGINS must include http://localhost:3000 (the wildcard is
# never honoured on /api/auth, so it has to be the explicit origin).
#
# ⚠️ Mutations are LIVE against the remote brain — point this at the test box,
# not prod.

set -euo pipefail

cd "$(dirname "$0")/.."

CONF=client/web/.env.detached.local
# Legacy location (pre-carve, when server/web hosted the owner UI).
LEGACY_CONF=server/web/.env.detached.local

if [[ ! -f $CONF && -f $LEGACY_CONF ]]; then
  echo "→ Migrating $LEGACY_CONF → $CONF (MANTLE_REMOTE only; tokens are no longer needed)." >&2
  grep '^MANTLE_REMOTE=' "$LEGACY_CONF" >"$CONF" || true
fi

if [[ ! -f $CONF ]]; then
  cat <<EOF >&2
$CONF is missing. Create it with:

  MANTLE_REMOTE=https://test.crossworks.network

Then sign in on the login page with that box's credentials.
EOF
  exit 1
fi

# shellcheck disable=SC1090
source "$CONF"

: "${MANTLE_REMOTE:?MANTLE_REMOTE missing from $CONF}"

echo "→ Frontend-only dev against $MANTLE_REMOTE (detached — no local DB)." >&2
echo "  (remote must CORS-allowlist http://localhost:3000 — see docs/db-less-dev.md)" >&2
MANTLE_SERVER_ORIGIN="$MANTLE_REMOTE" exec pnpm -C client/web dev "$@"
