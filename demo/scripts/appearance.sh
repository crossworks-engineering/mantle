#!/usr/bin/env bash
# Set the demo brain's look (theme, avatars, Neat background) on an already
# seeded brain, without a reseed: the writable seed stack, like embedder.sh.
# seed.sh does the same step on a fresh seed. Re-run pack.sh afterwards.
#
#   DEMO_NEAT_BACKGROUND='{"v":1,"seed":N,"tone":"auto","speed":2}' demo/scripts/appearance.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DEMO="demo"; ART="$DEMO/.run"; mkdir -p "$ART"

WEB_PORT=3902
export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:56432/postgres"
export S3_ENDPOINT="http://127.0.0.1:56900"
export S3_REGION="us-east-1"; export S3_ACCESS_KEY="minio"; export S3_SECRET_KEY="minio12345"; export S3_BUCKET="mantle"
export TIKA_URL="http://127.0.0.1:56998"
export MANTLE_DOCS_ROOT="$(pwd)/demo/generator/out/docs"
export MANTLE_PUBLIC_URL="${DEMO_PUBLIC_URL:-https://demo.mantle-ai.tech}"
export TABLE_DB_DIR="${DEMO_TABLE_DB_DIR:-$(pwd)/demo/.run/table-dbs}"
export MANTLE_FILES_ROOT="${DEMO_FILES_ROOT:-$(pwd)/demo/.run/files}"
# The brain's secrets, from demo/.run/secrets (demo/scripts/lib/secrets.sh):
# exports SESSION_SECRET, MANTLE_MASTER_KEY and the two demo passwords. They
# must be the ones the brain was seeded with, so this never makes new ones.
. "$DEMO/scripts/lib/secrets.sh"; demo_secrets require
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

web_pid_file="$ART/look-web.pid"; web_log="$ART/look-web.log"
api_pid_file="$ART/look-api.pid"; api_log="$ART/look-api.log"
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
      */server/web) echo "✗ a 'next dev' already holds server/web (PID $pid): stop it yourself." >&2; exit 1 ;;
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
echo "→ server/api: the extractor (log: $api_log)"
( setsid pnpm -C server/api start >"$api_log" 2>&1 & echo $! >"$api_pid_file" )
sleep 8
echo "→ the look: theme, avatars, Neat background"
DEMO_SERVER_URL="http://127.0.0.1:$WEB_PORT" pnpm -C server/web exec tsx ../../demo/seed/set-appearance.ts
