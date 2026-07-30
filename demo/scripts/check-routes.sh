#!/usr/bin/env bash
# P6b — the coverage gate. Walk every route in client/web/app against the
# running demo in a real browser and assert each one renders.
#
#   demo/scripts/check-routes.sh [base-url]     default: http://127.0.0.1:56080
#   DEMO_CHECK_ONLY=/journal,/traces demo/scripts/check-routes.sh
#
# Stand the target up first with demo/scripts/serve.sh. This is the check that
# would have caught v1's 85 blank screens, and it is deliberately the only one
# that opens a browser: check-readonly.sh proves the edge's read-only claim
# over HTTP, but no HTTP-level check can tell a rendered screen from an empty
# one — the nav shell alone is ~103KB.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Playwright and its browsers come from e2e/, which already has both. The gate
# itself lives entirely under demo/ and adds no dependency of its own.
if [ ! -d e2e/node_modules/@playwright ]; then
  echo "✗ Playwright is not installed — run: pnpm -C e2e install" >&2
  exit 2
fi

exec node demo/check/routes.mjs "${1:-http://127.0.0.1:56080}"
