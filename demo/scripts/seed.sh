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
# Documentation collections are DISK-backed: the generator writes the markdown
# and the app indexes it in place, so the docs root points straight at the
# generator's output. Absolute, and shared by every process that reads docs.
export MANTLE_DOCS_ROOT="$(cd "$(dirname "$0")/../.." && pwd)/demo/generator/out/docs"
export SESSION_SECRET="${DEMO_SESSION_SECRET:-demo-session-secret-0123456789abcdef0123456789ab}"
# Must base64-decode to EXACTLY 32 bytes or onboarding 500s ("must decode to
# 32 bytes"). This is 'demo-master-key-0123456789abcdef' — a fixed dummy, so a
# re-seed can reopen the vault it sealed; the demo holds no real secrets.
export MANTLE_MASTER_KEY="${DEMO_MASTER_KEY:-ZGVtby1tYXN0ZXIta2V5LTAxMjM0NTY3ODlhYmNkZWY=}"
export MANTLE_RATE_LIMIT_SCALE="${MANTLE_RATE_LIMIT_SCALE:-50}"   # a seed is a burst by nature
export EXTRACT_CONCURRENCY="${EXTRACT_CONCURRENCY:-4}"
# Onboarding provisions LOCAL embeddings, whose default URL is the compose
# service name `ollama` — which does not resolve here, because the seed runs
# the app from source on the host, not inside the compose network. Unset, every
# extraction dies with ECONNREFUSED (not a 401 — the failure looks nothing like
# a bad key, which is what makes it worth naming).
export MANTLE_LOCAL_EMBEDDING_URL="${MANTLE_LOCAL_EMBEDDING_URL:-http://127.0.0.1:56434/v1}"
export PORT="$WEB_PORT"
# Never let a developer's own .env.local (which may point at a REAL brain)
# leak into a seeding run — explicit process env beats .env.local in Next.
unset MANTLE_DETACHED_DEV NEXT_PUBLIC_MANTLE_API_BASE NEXT_PUBLIC_MANTLE_API_TOKEN MANTLE_DEMO || true

# The extractor needs a real chat model (summaries, facts, entities). The key
# is read from a file OUTSIDE the repo so it is never pasted into a terminal
# that is being transcribed, never lands in shell history, and never reaches
# the working tree. Create it yourself:
#
#   install -m 600 /dev/null ~/.mantle-demo-openrouter-key
#   $EDITOR ~/.mantle-demo-openrouter-key     # paste the key, nothing else
#
# Without it the seed still runs; extraction produces nothing and verify.ts
# fails with that exact diagnosis.
KEY_FILE="${DEMO_KEY_FILE:-$HOME/.mantle-demo-openrouter-key}"
if [ -z "${DEMO_OPENROUTER_KEY:-}" ] && [ -r "$KEY_FILE" ]; then
  DEMO_OPENROUTER_KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
  export DEMO_OPENROUTER_KEY
fi
if [ -n "${DEMO_OPENROUTER_KEY:-}" ]; then
  echo "→ chat model: key loaded (${#DEMO_OPENROUTER_KEY} chars) — extraction will run"
else
  echo "⚠ no chat-model key: content will seed but extraction produces nothing."
  echo "  See the KEY_FILE note in this script."
fi

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
  # `drizzle` holds the migration JOURNAL. Dropping public without it leaves
  # drizzle certain every migration is applied while none of the tables exist —
  # migrate then says "Already up to date." over an empty database and the
  # first insert fails with `relation "audit_log" does not exist`. Drop all
  # four or none.
  docker exec -i mantle_demo_pg psql -U postgres -d postgres -q <<'SQL'
drop schema if exists public cascade; create schema public;
drop schema if exists auth cascade;
drop schema if exists pgboss cascade;
drop schema if exists drizzle cascade;
SQL
  docker exec -i mantle_demo_pg psql -U postgres -d postgres -q < infra/postgres/init/01-extensions.sql
  docker exec -i mantle_demo_pg psql -U postgres -d postgres -q < infra/postgres/init/02-auth-schema.sql
fi

echo "→ migrations + pg-boss schema"
# Output kept on the log, not /dev/null: silencing it is what hid the
# "Already up to date." over an empty database above.
pnpm --filter @mantle/db migrate 2>&1 | tail -2
pnpm -C server/web pgboss:init 2>&1 | tail -1
# Prove the schema is really there — migrate reporting success is not enough.
docker exec -i mantle_demo_pg psql -U postgres -d postgres -At \
  -c "select to_regclass('public.audit_log') is not null and to_regclass('public.nodes') is not null" \
  | grep -qx t || { echo "✗ migrations reported success but the schema is missing" >&2; exit 1; }

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
