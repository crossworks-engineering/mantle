#!/usr/bin/env bash
# P4 — run the scripted turns against an ALREADY-SEEDED demo brain.
#
# Split from seed.sh on purpose: seeding and conversing fail for different
# reasons and cost different amounts, and you want to re-run the turns
# without re-seeding (or vice versa).
#
#   demo/scripts/turns.sh [--limit N]
set -euo pipefail
cd "$(dirname "$0")/../.."
DEMO="demo"; ART="$DEMO/.run"; mkdir -p "$ART"

WEB_PORT=3902
export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:56432/postgres"
export S3_ENDPOINT="http://127.0.0.1:56900"
export S3_REGION="us-east-1"; export S3_ACCESS_KEY="minio"; export S3_SECRET_KEY="minio12345"; export S3_BUCKET="mantle"
export TIKA_URL="http://127.0.0.1:56998"
export MANTLE_DOCS_ROOT="$(pwd)/demo/generator/out/docs"
export SESSION_SECRET="${DEMO_SESSION_SECRET:-demo-session-secret-0123456789abcdef0123456789ab}"
export MANTLE_MASTER_KEY="${DEMO_MASTER_KEY:-ZGVtby1tYXN0ZXIta2V5LTAxMjM0NTY3ODlhYmNkZWY=}"
export MANTLE_LOCAL_EMBEDDING_URL="${MANTLE_LOCAL_EMBEDDING_URL:-http://127.0.0.1:56434/v1}"
export MANTLE_RATE_LIMIT_SCALE="${MANTLE_RATE_LIMIT_SCALE:-50}"
# Runner queues. This flag is only HALF the switch — the `runs` tool group must
# also be granted to the assistant (demo/seed/enable-runs.ts below), or the
# worker idles and the assistant has no way to create a run. It must be set on
# web, api AND the runs worker: a flag set on one process only produces runs
# that are created and never executed.
export MANTLE_RUNS="${MANTLE_RUNS:-1}"
export PORT="$WEB_PORT"
unset MANTLE_DETACHED_DEV NEXT_PUBLIC_MANTLE_API_BASE NEXT_PUBLIC_MANTLE_API_TOKEN MANTLE_DEMO || true

web_pid_file="$ART/turns-web.pid"; web_log="$ART/turns-web.log"
api_pid_file="$ART/turns-api.pid"; api_log="$ART/turns-api.log"
runs_pid_file="$ART/turns-runs.pid"; runs_log="$ART/turns-runs.log"
cleanup() {
  for f in "$web_pid_file" "$api_pid_file" "$runs_pid_file"; do
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

# REGENERATE FIRST. out/ is gitignored, so whatever is on disk is from whenever
# the last seed ran — which silently replayed a stale, much smaller turn set
# and reported success. The turns module emits no nodes, so regenerating here
# cannot desync the already-seeded brain; it only refreshes the turn list.
echo "→ regenerate (turn list must match this checkout, not the last seed)"
node "$DEMO/generator/gen.mjs" >/dev/null
node -e "
  const j = require('./$DEMO/generator/out/manifest.json');
  console.log('  ' + j.turns.length + ' turns in the manifest');
"

echo "→ server/web on :$WEB_PORT"
( setsid pnpm -C server/web dev >"$web_log" 2>&1 & echo $! >"$web_pid_file" )
for i in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$WEB_PORT/api/version" >/dev/null 2>&1 && break
  sleep 1; [ "$i" = 120 ] && { echo "✗ web not ready"; tail -20 "$web_log"; exit 1; }
done
echo "  ready"

echo "→ server/api (traces + tool execution live here)"
( setsid pnpm -C server/api start >"$api_log" 2>&1 & echo $! >"$api_pid_file" )
sleep 8

echo "→ runs worker (executes what run_plan creates)"
( setsid pnpm -C server/web exec tsx workers/runs.ts >"$runs_log" 2>&1 & echo $! >"$runs_pid_file" )
sleep 4
grep -q "disabled" "$runs_log" 2>/dev/null && echo "  ⚠ worker reports runner queues DISABLED — MANTLE_RUNS did not reach it" || echo "  up"

echo "→ grant the \`runs\` tool group (the other half of the switch)"
DEMO_SERVER_URL="http://127.0.0.1:$WEB_PORT" \
  pnpm -C server/web exec tsx ../../demo/seed/enable-runs.ts

echo "→ running turns"
DEMO_SERVER_URL="http://127.0.0.1:$WEB_PORT" \
  pnpm -C server/web exec tsx ../../demo/seed/turns.ts "$@"

# The cleanup trap kills the runs worker the moment this script ends, so
# without an explicit drain every run is frozen mid-flight and /runs shows a
# wall of perpetually "running" jobs — which reads as broken, not busy.
if [ "${MANTLE_RUNS:-}" = "1" ]; then
  echo "→ draining runs (terminal states: done | failed | cancelled)"
  drain_deadline=$(( $(date +%s) + ${DEMO_RUN_DRAIN_S:-900} ))
  while [ "$(date +%s)" -lt "$drain_deadline" ]; do
    active=$(docker exec mantle_demo_pg psql -U postgres -d postgres -At \
      -c "select count(*) from runs where status not in ('done','failed','cancelled')" 2>/dev/null || echo 0)
    total=$(docker exec mantle_demo_pg psql -U postgres -d postgres -At \
      -c "select count(*) from runs" 2>/dev/null || echo 0)
    echo "  $((total - active))/$total settled"
    [ "$active" = "0" ] && break
    sleep 20
  done
  [ "${active:-1}" = "0" ] || echo "  ⚠ drain timed out — some runs remain in flight"
fi

echo "→ maintenance runs (populate maintenance_runs, and are honest work anyway)"
# NOTE: bare `pnpm maintain` only LISTS the registry — it runs nothing. Each
# task needs its slug. These four are read-only or idempotent and are genuine
# work on a freshly seeded brain: dedupe the entities extraction just created,
# dedupe graph edges, reap old traces, ensure the pg-boss schema. Deliberately
# NOT run: re-embed (expensive), rotate-master-key (destructive), sync-now
# (would try to reach a mailbox), backup-* (nothing to back up here).
for slug in entities-dedupe dedupe-edges traces-reap pgboss-init; do
  echo "  · $slug"
  pnpm maintain "$slug" 2>&1 | tail -2 || echo "    (reported nothing to do)"
done
