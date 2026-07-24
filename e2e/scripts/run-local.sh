#!/usr/bin/env bash
set -euo pipefail
#
# run-local.sh — boot the hermetic e2e stack, run the Playwright suite, tear
# down. The whole cycle is self-contained: throwaway pg/minio/browser on
# non-default ports, the web app on :3900, a FRESH owner created through real
# signup + onboarding by the suite's global-setup.
#
# Usage:
#   e2e/scripts/run-local.sh            # full cycle: up → migrate → web → test → down
#   e2e/scripts/run-local.sh up         # just infra + migrations + web (for iterating)
#   e2e/scripts/run-local.sh test       # run the suite against an `up`'d stack
#   e2e/scripts/run-local.sh down       # stop web + wipe the stack (down -v)
#
# Env overrides pass through (E2E_SERVER_URL etc. — see e2e/lib/env.ts).

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

compose=(docker compose -f e2e/stack/docker-compose.yml)
artifacts="$root/e2e/.artifacts"
web_pid_file="$artifacts/web.pid"
web_log="$artifacts/web.log"
port=3900

# The web app's env for THIS stack. Set explicitly so server/web/.env.local (which
# next dev always loads, and which may point at a REAL local brain) cannot leak
# in — explicit process env beats .env.local in Next.
export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:55432/postgres"
export S3_ENDPOINT="http://127.0.0.1:59000"
export S3_REGION="us-east-1"
export S3_ACCESS_KEY="minio"
export S3_SECRET_KEY="minio12345"
export S3_BUCKET="mantle"
export SESSION_SECRET="e2e-session-secret-0123456789abcdef0123456789abcdef"
export BROWSER_WS_ENDPOINT="ws://127.0.0.1:59222?token=mantle"
export MANTLE_PRINT_ORIGIN="http://host.docker.internal:${port}"
export PORT="$port"
unset MANTLE_DETACHED_DEV NEXT_PUBLIC_MANTLE_API_BASE NEXT_PUBLIC_MANTLE_API_TOKEN TIKA_URL || true

up() {
  mkdir -p "$artifacts"
  echo "→ infra up (mantle-e2e: pg :55432, minio :59000, browser :59222)"
  "${compose[@]}" up -d --wait postgres minio browser
  "${compose[@]}" run --rm createbucket
  echo "→ migrations + pg-boss schema"
  pnpm --filter @mantle/db migrate
  pnpm -C server/web pgboss:init
  echo "→ web app on :$port (log: $web_log)"
  # A stale server from an interrupted run holds the port and answers with the
  # WRONG code/DB — sweep it before starting.
  fuser -k "$port/tcp" 2>/dev/null && sleep 1 || true
  # `pnpm -C server/web dev` (not `exec next dev`) so the package's predev hook
  # generates public/app-runtime/ — the mini-app runtime the CORS spec checks.
  # PORT is exported above; next dev honours it. setsid gives the pnpm→next
  # chain its own process GROUP so teardown can kill the whole tree (killing
  # just the pnpm wrapper leaves next alive — the stale-port failure mode).
  ( setsid pnpm -C server/web dev >"$web_log" 2>&1 & echo $! >"$web_pid_file" )
  for i in $(seq 1 120); do
    if curl -sf "http://localhost:$port/api/version" >/dev/null 2>&1; then
      echo "→ web ready"
      return 0
    fi
    sleep 1
  done
  echo "✗ web did not become ready in 120s — tail of $web_log:" >&2
  tail -30 "$web_log" >&2
  return 1
}

run_tests() {
  E2E_SERVER_URL="${E2E_SERVER_URL:-http://localhost:$port}" \
    pnpm -C e2e e2e:same
}

down() {
  if [ -f "$web_pid_file" ]; then
    # Negative pid = the whole process group (see setsid in up()).
    kill -- "-$(cat "$web_pid_file")" 2>/dev/null || kill "$(cat "$web_pid_file")" 2>/dev/null || true
    rm -f "$web_pid_file"
  fi
  fuser -k "$port/tcp" 2>/dev/null || true
  "${compose[@]}" down -v --remove-orphans
}

case "${1:-run}" in
  up) up ;;
  test) run_tests ;;
  down) down ;;
  run)
    trap down EXIT
    up
    run_tests
    ;;
  *)
    echo "usage: $0 [run|up|test|down]" >&2
    exit 1
    ;;
esac
