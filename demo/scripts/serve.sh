#!/usr/bin/env bash
# Stand the SERVE-time demo up locally, exactly as the site box will run it:
# a Caddy in front doing the read-only edge, the real app behind it, and the
# app connected as the read-only Postgres role.
#
# This is what P5 is verified against — the edge is only real if you can poke
# it. Ports are the demo range, so it runs alongside everything else.
#
#   demo/scripts/serve.sh          up, then leaves it running
#   demo/scripts/serve.sh --check  up, run check-readonly.sh, tear down
set -euo pipefail
cd "$(dirname "$0")/../.."
DEMO="demo"; ART="$DEMO/.run"; mkdir -p "$ART"

# TWO apps. server/web is the API and has ZERO pages; ALL 94 screens live in
# client/web. Pointing the edge at server/web alone yields a working /api/* and
# a 404 for every actual page — which is exactly what happened the first time.
API_PORT=3903          # server/web — the API
UI_PORT=3904           # client/web — the 94 screens a visitor sees
EDGE_PORT=56080        # Caddy — this is what a visitor would hit
export DATABASE_URL="postgres://demo_reader:demo_reader_not_a_secret@127.0.0.1:56432/postgres"
export S3_ENDPOINT="http://127.0.0.1:56900"
export S3_REGION="us-east-1"; export S3_ACCESS_KEY="minio"; export S3_SECRET_KEY="minio12345"; export S3_BUCKET="mantle"
export TIKA_URL="http://127.0.0.1:56998"
export MANTLE_DOCS_ROOT="$(pwd)/demo/generator/out/docs"
export SESSION_SECRET="${DEMO_SESSION_SECRET:-demo-session-secret-0123456789abcdef0123456789ab}"
export MANTLE_MASTER_KEY="${DEMO_MASTER_KEY:-ZGVtby1tYXN0ZXIta2V5LTAxMjM0NTY3ODlhYmNkZWY=}"
export MANTLE_LOCAL_EMBEDDING_URL="${MANTLE_LOCAL_EMBEDDING_URL:-http://127.0.0.1:56434/v1}"
export PORT="$API_PORT"
unset MANTLE_DETACHED_DEV NEXT_PUBLIC_MANTLE_API_BASE NEXT_PUBLIC_MANTLE_API_TOKEN MANTLE_DEMO MANTLE_RUNS || true

web_pid_file="$ART/serve-web.pid"; web_log="$ART/serve-web.log"
ui_pid_file="$ART/serve-ui.pid";   ui_log="$ART/serve-ui.log"
cleanup() {
  for f in "$web_pid_file" "$ui_pid_file"; do
    [ -f "$f" ] || continue
    pgid=$(ps -o pgid= -p "$(cat "$f")" 2>/dev/null | tr -d ' ')
    [ -n "${pgid:-}" ] && kill -TERM -"$pgid" 2>/dev/null
    rm -f "$f"
  done
  docker rm -f mantle_demo_edge >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "→ read-only Postgres role"
docker exec -i mantle_demo_pg psql -U postgres -d postgres -q < "$DEMO/deploy/readonly-role.sql"
echo "  demo_reader ready"

echo "→ mint the visitor session"
# Minted with the OWNER connection: the reader role cannot even read auth.users
# until the grants above land, and this must not depend on that ordering.
SESSION=$(DATABASE_URL="postgres://postgres:postgres@127.0.0.1:56432/postgres" \
  pnpm -s -C server/web exec tsx ../../demo/seed/mint-session.ts | tail -1)
[ -n "$SESSION" ] || { echo "✗ failed to mint a session"; exit 1; }
echo "  minted (${#SESSION} chars, never printed)"

echo "→ render the edge config"
mkdir -p "$ART/edge"
sed -e "s|__DEMO_SESSION__|$SESSION|" \
    -e "s|__DEMO_WEB__|host.docker.internal:$UI_PORT|" \
    -e "s|__DEMO_API__|host.docker.internal:$API_PORT|" \
    -e "s|^demo\.mantle-ai\.tech {|:80 {|" \
    "$DEMO/deploy/Caddyfile.demo" > "$ART/edge/Caddyfile"

echo "→ API (server/web) on :$API_PORT (as demo_reader)"
( setsid pnpm -C server/web dev >"$web_log" 2>&1 & echo $! >"$web_pid_file" )
for i in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$API_PORT/api/version" >/dev/null 2>&1 && break
  sleep 1; [ "$i" = 120 ] && { echo "✗ API not ready:"; tail -25 "$web_log"; exit 1; }
done
echo "  ready"

# Safe alongside a running dev stack: Next's one-dev-server-per-project-DIRECTORY
# limit matches by CWD, and this worktree's client/web is a different directory
# with its own .next (see the repo CLAUDE.md on worktrees).
echo "→ UI (client/web) on :$UI_PORT — this is where the 94 screens live"
# MANTLE_SERVER_ORIGIN is baked into env.js and tells the BROWSER where to
# send its fetches. It must be the EDGE, not the API: point it at the API and
# the browser bypasses Caddy entirely, gets no injected cookie, and every
# screen spins forever behind a 401 while the pages themselves render fine.
# One origin is the whole design — /api/* and the UI share a host so there is
# no CORS and the edge can authenticate every call.
( setsid env PORT="$UI_PORT" MANTLE_SERVER_ORIGIN="http://127.0.0.1:$EDGE_PORT" \
    pnpm -C client/web dev >"$ui_log" 2>&1 & echo $! >"$ui_pid_file" )
for i in $(seq 1 180); do
  curl -sf "http://127.0.0.1:$UI_PORT/env.js" >/dev/null 2>&1 && break
  sleep 1; [ "$i" = 180 ] && { echo "✗ UI not ready:"; tail -25 "$ui_log"; exit 1; }
done
echo "  ready"

echo "→ edge on :$EDGE_PORT"
docker rm -f mantle_demo_edge >/dev/null 2>&1 || true
docker run -d --name mantle_demo_edge \
  --add-host host.docker.internal:host-gateway \
  -p "127.0.0.1:$EDGE_PORT:80" \
  -v "$(pwd)/$ART/edge/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine >/dev/null
sleep 3
curl -sf "http://127.0.0.1:$EDGE_PORT/api/version" >/dev/null 2>&1 \
  && echo "  edge up" || { echo "✗ edge not answering"; docker logs mantle_demo_edge | tail -15; exit 1; }

if [ "${1:-}" = "--check" ]; then
  echo
  "$DEMO/scripts/check-readonly.sh" "http://127.0.0.1:$EDGE_PORT"
  exit $?
fi

echo
echo "demo serving at http://127.0.0.1:$EDGE_PORT  (ctrl-c to stop)"
# `wait` would return immediately: the app was setsid'd into its own session,
# so it is not a job of this shell and the script would exit at once — taking
# the EXIT trap's teardown with it, or (with the trap removed) leaving a stack
# nobody is watching. Poll the app instead, and tear down when it goes away.
while kill -0 "$(cat "$web_pid_file" 2>/dev/null)" 2>/dev/null \
   && kill -0 "$(cat "$ui_pid_file" 2>/dev/null)" 2>/dev/null; do sleep 5; done
echo "app exited — tearing down the edge"
