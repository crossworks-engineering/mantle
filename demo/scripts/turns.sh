#!/usr/bin/env bash
# The five REAL chats, on a seeded AND drained demo brain: four owner turns
# (generator/content/turns.mjs) and one member question (seed/seed-member-chat.ts).
# Their traces, context traces and messages are the only behavioural data
# the demo carries: nothing else generates traces, runs or audit filler.
#
#   demo/scripts/seed.sh && demo/scripts/drain.sh && demo/scripts/turns.sh
#
# It REFUSES to run before the drain. A real turn on an undrained brain loops
# through the tools and burns 450k to 600k input tokens before it times out
# (seen on the bench), so the guard below counts unextracted nodes and the
# extractor queue first.
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
# Same paths as seed.sh and drain.sh: a turn that reads a table or a file
# needs the workbooks and bytes where the seed wrote them.
export TABLE_DB_DIR="${DEMO_TABLE_DB_DIR:-$(pwd)/demo/.run/table-dbs}"
export MANTLE_FILES_ROOT="${DEMO_FILES_ROOT:-$(pwd)/demo/.run/files}"
# The brain's secrets, from demo/.run/secrets (demo/scripts/lib/secrets.sh):
# they must be the ones the brain was seeded with, so this never makes new ones.
. "$DEMO/scripts/lib/secrets.sh"; demo_secrets require
export MANTLE_LOCAL_EMBEDDING_URL="${MANTLE_LOCAL_EMBEDDING_URL:-http://127.0.0.1:56434/v1}"
export MANTLE_RATE_LIMIT_SCALE="${MANTLE_RATE_LIMIT_SCALE:-50}"
export PORT="$WEB_PORT"
unset MANTLE_DETACHED_DEV NEXT_PUBLIC_MANTLE_API_BASE NEXT_PUBLIC_MANTLE_API_TOKEN MANTLE_DEMO || true

PG="${DEMO_PG_CONTAINER:-mantle_demo_pg}"
web_pid_file="$ART/turns-web.pid"; web_log="$ART/turns-web.log"
api_pid_file="$ART/turns-api.pid"; api_log="$ART/turns-api.log"
cleanup() {
  for f in "$web_pid_file" "$api_pid_file"; do
    [ -f "$f" ] || continue
    pgid=$(ps -o pgid= -p "$(cat "$f")" 2>/dev/null | tr -d " " || true)
    [ -n "${pgid:-}" ] && kill -TERM -"$pgid" 2>/dev/null || true
    rm -f "$f"
  done
}
trap cleanup EXIT

if [ -d /proc ]; then
  for pid in $(pgrep -f "next dev" 2>/dev/null || true); do
    case "$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)" in
      */server/web) echo "✗ a next dev already holds server/web (PID $pid): stop it yourself." >&2; exit 1 ;;
    esac
  done
fi

echo "→ demo stack"
"$DEMO/scripts/stack-up.sh" >/dev/null

echo "→ is the brain drained?"
outstanding=$(docker exec "$PG" psql -U postgres -d postgres -At -c \
  "select count(*) from nodes where type not in ('branch') and not (data ? 'extract_completed_at') and not (data ? 'extract_skipped')" 2>/dev/null || echo "?")
queued=$(docker exec "$PG" psql -U postgres -d postgres -At -c \
  "select count(*) from pgboss.job where name like '%extract%' and state in ('created','active','retry')" 2>/dev/null || echo "?")
echo "  unextracted nodes: $outstanding · extractor queue: $queued"
if [ "$queued" != "0" ] || { [ "$outstanding" != "0" ] && [ "${DEMO_TURNS_FORCE:-}" != "1" ]; }; then
  echo "✗ NOT drained. Run demo/scripts/drain.sh first. Real turns on an undrained brain" >&2
  echo "  burn hundreds of thousands of tokens each. (If the remaining nodes are kinds the" >&2
  echo "  extractor never marks, check them and rerun with DEMO_TURNS_FORCE=1.)" >&2
  exit 1
fi

echo "→ server/web on :$WEB_PORT"
( setsid pnpm -C server/web dev >"$web_log" 2>&1 & echo $! >"$web_pid_file" )
for i in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$WEB_PORT/api/version" >/dev/null 2>&1 && break
  sleep 1; [ "$i" = 120 ] && { echo "✗ web not ready"; tail -20 "$web_log"; exit 1; }
done
echo "  ready"

echo "→ server/api (traces and tool execution live here)"
( setsid pnpm -C server/api start >"$api_log" 2>&1 & echo $! >"$api_pid_file" )
sleep 8

echo "→ the owner chats"
DEMO_SERVER_URL="http://127.0.0.1:$WEB_PORT" \
  pnpm -C server/web exec tsx ../../demo/seed/turns.ts "$@"

echo "→ the member chat"
DEMO_SERVER_URL="http://127.0.0.1:$WEB_PORT" \
  pnpm -C server/web exec tsx ../../demo/seed/seed-member-chat.ts

echo "→ verify, now with the chats"
pnpm -C server/web exec tsx ../../demo/seed/verify.ts --wait 120 --chats
