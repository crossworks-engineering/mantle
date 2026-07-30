#!/usr/bin/env bash
# One command: stack → migrations → server + extractor → generate → seed → verify.
#
# The cadence plan rests on this being ONE command. A re-seed that is a manual
# afternoon happens twice and then never — which is how v1 died.
#
#   demo/scripts/seed.sh            full run (wipes and re-seeds)
#   demo/scripts/seed.sh --keep     seed into the existing demo brain
#
# Runs entirely on the demo stack's own ports. It never stops anything else:
# a real Mantle stack is expected to be running on this host.
set -euo pipefail
cd "$(dirname "$0")/../.."          # repo root
DEMO="demo"
ART="$DEMO/.run"; mkdir -p "$ART"

WEB_PORT=3902
export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:56432/postgres"
export S3_ENDPOINT="http://127.0.0.1:56900"
export S3_REGION="us-east-1"
export S3_ACCESS_KEY="minio"
export S3_SECRET_KEY="minio12345"
export S3_BUCKET="mantle"
export TIKA_URL="http://127.0.0.1:56998"
export SESSION_SECRET="${DEMO_SESSION_SECRET:-demo-session-secret-0123456789abcdef0123456789ab}"
# Must base64-decode to EXACTLY 32 bytes or onboarding 500s ("must decode to
# 32 bytes"). This is 'demo-master-key-0123456789abcdef' — a fixed dummy, so a
# re-seed can reopen the vault it sealed; the demo holds no real secrets.
export MANTLE_MASTER_KEY="${DEMO_MASTER_KEY:-ZGVtby1tYXN0ZXIta2V5LTAxMjM0NTY3ODlhYmNkZWY=}"
export MANTLE_RATE_LIMIT_SCALE="${MANTLE_RATE_LIMIT_SCALE:-50}"   # a seed is a burst by nature
export EXTRACT_CONCURRENCY="${EXTRACT_CONCURRENCY:-4}"
export PORT="$WEB_PORT"
# Never let a developer's own .env.local (which may point at a REAL brain)
# leak into a seeding run — explicit process env beats .env.local in Next.
unset MANTLE_DETACHED_DEV NEXT_PUBLIC_MANTLE_API_BASE NEXT_PUBLIC_MANTLE_API_TOKEN MANTLE_DEMO || true

web_pid_file="$ART/web.pid"; web_log="$ART/web.log"
api_pid_file="$ART/api.pid"; api_log="$ART/api.log"

cleanup() {
  for f in "$web_pid_file" "$api_pid_file"; do
    [ -f "$f" ] || continue
    pid=$(cat "$f"); pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    [ -n "${pgid:-}" ] && kill -TERM -"$pgid" 2>/dev/null || true
    rm -f "$f"
  done
}
trap cleanup EXIT

# Next permits only ONE dev server per project DIRECTORY (not per port), so a
# running dev stack in server/web makes this fail with a useless timeout. Name
# the real reason instead. Matched by CWD so unrelated projects don't trip it.
if [ -d /proc ]; then
  for pid in $(pgrep -f 'next dev' 2>/dev/null || true); do
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    case "$cwd" in
      */server/web)
        echo "✗ a 'next dev' is already running in server/web (PID $pid)." >&2
        echo "  Next allows one per project dir, so the demo server cannot start." >&2
        echo "  Stop that dev server yourself — this script never kills anything." >&2
        exit 1 ;;
    esac
  done
fi

echo "→ demo stack"
"$DEMO/scripts/stack-up.sh" >/dev/null

if [ "${1:-}" != "--keep" ]; then
  echo "→ fresh brain (dropping demo schema contents)"
  docker exec -i mantle_demo_pg psql -U postgres -d postgres -q <<'SQL'
drop schema if exists public cascade; create schema public;
drop schema if exists auth cascade;
drop schema if exists pgboss cascade;
SQL
  docker exec -i mantle_demo_pg psql -U postgres -d postgres -q < infra/postgres/init/01-extensions.sql
  docker exec -i mantle_demo_pg psql -U postgres -d postgres -q < infra/postgres/init/02-auth-schema.sql
fi

echo "→ migrations + pg-boss schema"
pnpm --filter @mantle/db migrate >/dev/null
pnpm -C server/web pgboss:init >/dev/null

echo "→ generate content"
node "$DEMO/generator/gen.mjs" | tail -3
node "$DEMO/generator/guard.mjs" "$DEMO/generator/out"

echo "→ server/web on :$WEB_PORT (log: $web_log)"
( setsid pnpm -C server/web dev >"$web_log" 2>&1 & echo $! >"$web_pid_file" )
for i in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$WEB_PORT/api/version" >/dev/null 2>&1 && break
  sleep 1
  [ "$i" = 120 ] && { echo "✗ server/web not ready:"; tail -30 "$web_log"; exit 1; }
done
echo "  ready"

echo "→ server/api — the extractor (log: $api_log)"
( setsid pnpm -C server/api start >"$api_log" 2>&1 & echo $! >"$api_pid_file" )
sleep 8

echo "→ seed"
DEMO_SERVER_URL="http://127.0.0.1:$WEB_PORT" \
  pnpm -C server/web exec tsx ../../demo/seed/seed.ts

echo "→ verify (waits for extraction to drain)"
pnpm -C server/web exec tsx ../../demo/seed/verify.ts --wait "${DEMO_VERIFY_WAIT:-900}"
