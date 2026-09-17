#!/usr/bin/env bash
# Let the extractor finish, then assert the seed — WITHOUT re-seeding.
#
#   demo/scripts/drain.sh [--wait SECONDS]      default 7200
#
# seed.sh and turns.sh both take the extractor (server/api) down with them
# when they exit, and verify.ts only waits as long as it is told. On a bench
# where the chat model does six nodes a minute, a 764-node seed is two hours
# of extraction — longer than either script's window. Until 2026-09-17 the
# only way to finish was to leave seed.sh's verify waiting 900s, watch it
# fail with "665 outstanding", and have nothing to run next. This is the
# thing to run next: same env as seed.sh, the API and the extractor up, and
# verify.ts told to wait as long as the queue needs.
set -euo pipefail
cd "$(dirname "$0")/../.."
DEMO="demo"; ART="$DEMO/.run"; mkdir -p "$ART"
WAIT_S=7200
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT_S="$2"; shift 2 ;;
    *) echo "usage: demo/scripts/drain.sh [--wait SECONDS]" >&2; exit 2 ;;
  esac
done

WEB_PORT=3902
export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:56432/postgres"
export S3_ENDPOINT="http://127.0.0.1:56900"
export S3_REGION="us-east-1"; export S3_ACCESS_KEY="minio"; export S3_SECRET_KEY="minio12345"; export S3_BUCKET="mantle"
export TIKA_URL="http://127.0.0.1:56998"
export MANTLE_DOCS_ROOT="$(pwd)/demo/generator/out/docs"
export MANTLE_PUBLIC_URL="${DEMO_PUBLIC_URL:-https://demo.mantle-ai.tech}"
export TABLE_DB_DIR="${DEMO_TABLE_DB_DIR:-$(pwd)/demo/.run/table-dbs}"
export MANTLE_FILES_ROOT="${DEMO_FILES_ROOT:-$(pwd)/demo/.run/files}"
export SESSION_SECRET="${DEMO_SESSION_SECRET:-demo-session-secret-0123456789abcdef0123456789ab}"
export MANTLE_MASTER_KEY="${DEMO_MASTER_KEY:-ZGVtby1tYXN0ZXIta2V5LTAxMjM0NTY3ODlhYmNkZWY=}"
export MANTLE_RATE_LIMIT_SCALE="${MANTLE_RATE_LIMIT_SCALE:-50}"
export EXTRACT_CONCURRENCY="${EXTRACT_CONCURRENCY:-4}"
export MANTLE_LOCAL_EMBEDDING_URL="${MANTLE_LOCAL_EMBEDDING_URL:-http://127.0.0.1:56434/v1}"
export PORT="$WEB_PORT"
unset MANTLE_DETACHED_DEV NEXT_PUBLIC_MANTLE_API_BASE NEXT_PUBLIC_MANTLE_API_TOKEN MANTLE_DEMO || true

# The chat model key, exactly as seed.sh finds it.
KEY_FILE="${DEMO_KEY_FILE:-$HOME/.mantle-demo-openrouter-key}"
if [ -z "${DEMO_OPENROUTER_KEY:-}" ] && [ -r "$KEY_FILE" ]; then
  DEMO_OPENROUTER_KEY="$(tr -d '[:space:]' < "$KEY_FILE")"; export DEMO_OPENROUTER_KEY
fi

web_pid_file="$ART/drain-web.pid"; web_log="$ART/drain-web.log"
api_pid_file="$ART/drain-api.pid"; api_log="$ART/drain-api.log"
cleanup() {
  for f in "$web_pid_file" "$api_pid_file"; do
    [ -f "$f" ] || continue
    pgid=$(ps -o pgid= -p "$(cat "$f")" 2>/dev/null | tr -d ' ' || true)
    [ -n "${pgid:-}" ] && kill -TERM -"$pgid" 2>/dev/null || true
    rm -f "$f"
  done
}
trap cleanup EXIT

if [ -d /proc ]; then
  for pid in $(pgrep -f 'next dev' 2>/dev/null || true); do
    case "$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)" in
      */server/web) echo "✗ a 'next dev' already holds server/web (PID $pid) — stop it yourself." >&2; exit 1 ;;
    esac
  done
fi

echo "→ demo stack"
"$DEMO/scripts/stack-up.sh" >/dev/null
echo "→ server/web on :$WEB_PORT (the extractor's event source)"
( setsid pnpm -C server/web dev >"$web_log" 2>&1 & echo $! >"$web_pid_file" )
for i in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$WEB_PORT/api/version" >/dev/null 2>&1 && break
  sleep 1; [ "$i" = 120 ] && { echo "✗ web not ready"; tail -20 "$web_log"; exit 1; }
done
echo "  ready"
echo "→ server/api — the extractor (log: $api_log)"
( setsid pnpm -C server/api start >"$api_log" 2>&1 & echo $! >"$api_pid_file" )
sleep 8
echo "→ verify (waits up to ${WAIT_S}s for extraction to drain)"
pnpm -C server/web exec tsx ../../demo/seed/verify.ts --wait "$WAIT_S"
