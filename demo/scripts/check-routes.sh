#!/usr/bin/env bash
# The coverage gate — walk every screen against the running demo in a real
# browser and assert each one renders — now LIVES IN THE JACKDAW REPO
# (e2e/check-routes.mjs), because it derives its route list from
# client/web/app and those screens left this repo in the 2026-08-13 split.
# A copy kept here would have gone quietly stale against the very screens it
# claims to cover, which is the failure the gate exists to catch.
#
#   demo/scripts/check-routes.sh [base-url]     default: http://127.0.0.1:56080
#   JACKDAW_DIR=../jackdaw demo/scripts/check-routes.sh https://demo.mantle-ai.tech
#   ROUTES_ONLY=/journal,/traces demo/scripts/check-routes.sh
#
# Stand the target up first with demo/scripts/serve.sh, or point it at the
# live demo. The jackdaw checkout needs `pnpm -C e2e install` once.
set -euo pipefail
cd "$(dirname "$0")/../.."

JACKDAW="${JACKDAW_DIR:-../jackdaw}"
GATE="$JACKDAW/e2e/check-routes.mjs"
if [ ! -f "$GATE" ]; then
  echo "✗ no jackdaw checkout at $JACKDAW — set JACKDAW_DIR; the gate is e2e/check-routes.mjs there" >&2
  exit 2
fi

# The bench's API log, so a server-side error the browser never sees is still
# counted. Absent (the live box), the gate simply reports what the browser saw.
export ROUTES_API_LOG="${ROUTES_API_LOG:-$(pwd)/demo/.run/serve-web.log}"
exec node "$GATE" "${1:-http://127.0.0.1:56080}"
