#!/usr/bin/env bash
# Run ONLY the web frontend, detached from any local backend — no Docker, no
# Postgres, no workers. The browser talks straight to a deployed Mantle's HTTP
# API (the FE/BE-split detached mode, docs/db-less-dev.md).
#
# Invoke via `pnpm dev:fe`. Extra args pass through to `next dev`
# (e.g. `pnpm dev:fe --port 3001`).
#
# Config lives in apps/web/.env.detached.local (git-ignored):
#
#   MANTLE_REMOTE=https://test.crossworks.network
#   MANTLE_REMOTE_EMAIL=you@example.com
#   MANTLE_REMOTE_PASSWORD=…            # only needed to (re)mint the token
#   NEXT_PUBLIC_MANTLE_API_TOKEN=…      # cached bearer; auto-minted + written back
#
# The token is a 1-year bearer minted from the remote's /api/auth/mobile-login.
# If it's missing (or rejected at boot) the script re-mints from the stored
# credentials and persists it back into the file.
#
# ⚠️ Mutations are LIVE against the remote brain — point this at the test box,
# not prod.

set -euo pipefail

cd "$(dirname "$0")/.."

CONF=apps/web/.env.detached.local

if [[ ! -f $CONF ]]; then
  cat <<EOF >&2
$CONF is missing. Create it with:

  MANTLE_REMOTE=https://test.crossworks.network
  MANTLE_REMOTE_EMAIL=<login email on that box>
  MANTLE_REMOTE_PASSWORD=<its password>

The bearer token is minted and cached automatically on first run.
EOF
  exit 1
fi

# shellcheck disable=SC1090
source "$CONF"

: "${MANTLE_REMOTE:?MANTLE_REMOTE missing from $CONF}"

mint_token() {
  : "${MANTLE_REMOTE_EMAIL:?no cached token and MANTLE_REMOTE_EMAIL missing from $CONF}"
  : "${MANTLE_REMOTE_PASSWORD:?no cached token and MANTLE_REMOTE_PASSWORD missing from $CONF}"
  echo "→ Minting bearer token from $MANTLE_REMOTE …" >&2
  local resp
  resp=$(curl -sf -X POST "$MANTLE_REMOTE/api/auth/mobile-login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$MANTLE_REMOTE_EMAIL\",\"password\":\"$MANTLE_REMOTE_PASSWORD\"}") || {
    echo "Token mint failed — check MANTLE_REMOTE / credentials in $CONF." >&2
    exit 1
  }
  node -e 'const r=JSON.parse(process.argv[1]); if(!r.token) process.exit(1); console.log(r.token)' "$resp"
}

# Probe a cached token against the remote; re-mint if missing or rejected
# (expired, or the box was reset and re-onboarded since the last mint).
token_ok() {
  [[ -n ${NEXT_PUBLIC_MANTLE_API_TOKEN:-} ]] || return 1
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "authorization: Bearer $NEXT_PUBLIC_MANTLE_API_TOKEN" \
    "$MANTLE_REMOTE/api/shell")
  [[ $code == 200 ]]
}

if ! token_ok; then
  NEXT_PUBLIC_MANTLE_API_TOKEN=$(mint_token)
  # Persist the fresh token back into the config (replace or append the line).
  if grep -q '^NEXT_PUBLIC_MANTLE_API_TOKEN=' "$CONF"; then
    tmp=$(mktemp)
    sed "s|^NEXT_PUBLIC_MANTLE_API_TOKEN=.*|NEXT_PUBLIC_MANTLE_API_TOKEN=$NEXT_PUBLIC_MANTLE_API_TOKEN|" "$CONF" >"$tmp"
    mv "$tmp" "$CONF"
  else
    printf '\nNEXT_PUBLIC_MANTLE_API_TOKEN=%s\n' "$NEXT_PUBLIC_MANTLE_API_TOKEN" >>"$CONF"
  fi
  echo "→ Token cached in $CONF." >&2
fi

export MANTLE_DETACHED_DEV=1
export NEXT_PUBLIC_MANTLE_API_BASE="$MANTLE_REMOTE"
export NEXT_PUBLIC_MANTLE_API_TOKEN
export MANTLE_DEV_EMAIL="${MANTLE_REMOTE_EMAIL:-}"

echo "→ Frontend-only dev against $MANTLE_REMOTE (detached — no local DB)." >&2
exec pnpm -C apps/web dev "$@"
