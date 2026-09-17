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

# TWO apps. server/web is the API and has ZERO pages; every screen lives in
# the CLIENT, which since the 2026-08-13 split is the jackdaw repo and reaches
# this bench only as its published image (titanwest/mantle-client) — exactly
# what the site box runs. Pointing the edge at server/web alone yields a
# working /api/* and a 404 for every actual page — which is exactly what
# happened the first time.
API_PORT=3903          # server/web — the API, from THIS checkout
UI_PORT=3904           # the client image — every screen a visitor sees
EDGE_PORT=56080        # Caddy — this is what a visitor would hit
# Which client. The pair file names the jackdaw release this server tree was
# tested with; DEMO_UI_IMAGE overrides it entirely (a locally built image from
# a jackdaw checkout: `docker build --target client -t mantle-client:local .`),
# which is how an unreleased client is walked against the demo brain.
DEMO_CLIENT_TAG="${DEMO_CLIENT_TAG:-$(tr -d '[:space:]' < client-pair.tag)}"
DEMO_UI_IMAGE="${DEMO_UI_IMAGE:-${MANTLE_IMAGE_NAMESPACE:-titanwest}/mantle-client:$DEMO_CLIENT_TAG}"
# The guided tour the client opens once per browser (jackdaw docs/tour.md).
DEMO_TOUR="${DEMO_TOUR:-demo}"
export DATABASE_URL="postgres://demo_reader:demo_reader_not_a_secret@127.0.0.1:56432/postgres"
export S3_ENDPOINT="http://127.0.0.1:56900"
export S3_REGION="us-east-1"; export S3_ACCESS_KEY="minio"; export S3_SECRET_KEY="minio12345"; export S3_BUCKET="mantle"
export TIKA_URL="http://127.0.0.1:56998"
export MANTLE_DOCS_ROOT="$(pwd)/demo/generator/out/docs"
# Table workbooks are SQLite files on disk, and Postgres only holds the
# registry that points at them. Left to its default the path resolves to the
# workspace root's .table-dbs — which is the CHECKOUT you happen to be in, so
# seeding from the worktree and serving from the clone put the registry and the
# workbooks in different directories and every table 500s with
# TableFileMissingError. Pin it to one demo-owned path so seed and serve can
# never disagree. NOTE for P7: this directory is seeded data and must ship with
# the pg dump — a deploy that carries only the database gets hollow tables.
export TABLE_DB_DIR="${DEMO_TABLE_DB_DIR:-$(pwd)/demo/.run/table-dbs}"
# File BYTES. Same cwd-relative trap as the docs root and the table
# workbooks, and the third time it bit this demo: filesRoot() resolves
# './data/files' against each process's cwd, so the API (cwd server/web)
# in one checkout writes where the extractor in another cannot read. The
# symptom is silent — 35 PDFs and 26 images ingested as nodes with no text
# and no chunks, unsearchable, with no error anywhere. filesRoot() warns
# about exactly this; nothing was listening.
export MANTLE_FILES_ROOT="${DEMO_FILES_ROOT:-$(pwd)/demo/.run/files}"
export SESSION_SECRET="${DEMO_SESSION_SECRET:-demo-session-secret-0123456789abcdef0123456789ab}"
export MANTLE_MASTER_KEY="${DEMO_MASTER_KEY:-ZGVtby1tYXN0ZXIta2V5LTAxMjM0NTY3ODlhYmNkZWY=}"
export MANTLE_LOCAL_EMBEDDING_URL="${MANTLE_LOCAL_EMBEDDING_URL:-http://127.0.0.1:56434/v1}"
# The origin absolute links are built against. seed.sh already sets this because
# generated content bakes links permanently; serve time needs it too, for the
# links the UI builds live — a share URL shown to a visitor as
# http://localhost:3000/s/<token> is a link to their own machine. The app has
# been logging "[boot] MANTLE_PUBLIC_URL is unset" on every start of this bench.
export MANTLE_PUBLIC_URL="${DEMO_PUBLIC_URL:-http://127.0.0.1:$EDGE_PORT}"
export PORT="$API_PORT"
unset MANTLE_DETACHED_DEV NEXT_PUBLIC_MANTLE_API_BASE NEXT_PUBLIC_MANTLE_API_TOKEN MANTLE_DEMO MANTLE_RUNS || true

web_pid_file="$ART/serve-web.pid"; web_log="$ART/serve-web.log"
cleanup() {
  if [ -f "$web_pid_file" ]; then
    pgid=$(ps -o pgid= -p "$(cat "$web_pid_file")" 2>/dev/null | tr -d ' ')
    [ -n "${pgid:-}" ] && kill -TERM -"$pgid" 2>/dev/null
    rm -f "$web_pid_file"
  fi
  docker rm -f mantle_demo_ui mantle_demo_edge >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "→ docs root"
# Two different things live under one root, and BOTH are read from disk at
# request time rather than from Postgres — so a root that is missing or
# incomplete produces empty screens with no error anywhere.
#
#   generated demo docs   what the seeded `documentation` nodes point at. The
#                         generator is deterministic, so regenerating gives
#                         byte-identical files; missing here means the seed ran
#                         in a different checkout (the same trap as the table
#                         workbooks — see TABLE_DB_DIR below).
#   guide/06-help         the per-screen help topics. PRODUCT documentation,
#                         not brain content: /api/help/<topic> resolves
#                         docsRoot()/guide/06-help/<topic>.md. Without it every
#                         "?" panel in the demo answers 404 while looking fine.
if [ ! -d "$MANTLE_DOCS_ROOT" ]; then
  echo "  generating (deterministic — matches what was seeded)"
  node "$DEMO/generator/gen.mjs" >/dev/null
fi
mkdir -p "$MANTLE_DOCS_ROOT/guide"
cp -a docs/guide/06-help "$MANTLE_DOCS_ROOT/guide/"
echo "  $(find "$MANTLE_DOCS_ROOT" -name '*.md' | wc -l | tr -d ' ') markdown files ($(ls "$MANTLE_DOCS_ROOT/guide/06-help" | wc -l | tr -d ' ') help topics)"

echo "→ schema — bring the seed brain up to this checkout"
# The brain was seeded on one release and this checkout is a later one, so
# its migrations may be missing — the API then 500s on any screen whose query
# names a new column (GET /api/tasks did, 13 migrations behind). The same
# trio the production migrate gate runs, as the OWNER: the reader role could
# not, and the seed stack is throwaway by design. Idempotent, so a bench
# already at this schema pays a second of checks.
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:56432/postgres" \
  pnpm -s -C packages/db migrate >"$ART/serve-migrate.log" 2>&1 \
  || { echo "✗ migrate failed:"; tail -20 "$ART/serve-migrate.log"; exit 1; }
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:56432/postgres" \
  pnpm -s -C server/web pgboss:init >>"$ART/serve-migrate.log" 2>&1 \
  && DATABASE_URL="postgres://postgres:postgres@127.0.0.1:56432/postgres" \
  pnpm -s -C server/api provision >>"$ART/serve-migrate.log" 2>&1 \
  || { echo "✗ pgboss:init / provision failed:"; tail -20 "$ART/serve-migrate.log"; exit 1; }
echo "  $(grep -oE 'applied [0-9]+ migration' "$ART/serve-migrate.log" | tail -1 || echo 'up to date')"

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

# The portal's own credential. Minted from (ownerId, contactId) rather than a
# raw token, and it only works because enable-team.ts made a seeded contact a
# real member — the liveness check re-queries contact_team_tokens on every call.
# An empty value is left as-is rather than failing: a demo without a member
# still serves, it just shows the token box on /team.
echo "→ mint the team-portal cookie"
TEAM=$(DATABASE_URL="postgres://postgres:postgres@127.0.0.1:56432/postgres" \
  pnpm -s -C server/web exec tsx ../../demo/seed/mint-team-cookie.ts 2>/dev/null | tail -1 || true)
if [ -n "$TEAM" ]; then
  echo "  minted (${#TEAM} chars, never printed)"
else
  echo "  ⚠ no team member on this brain — /team and /hub will show the token box"
  echo "    (run demo/seed/enable-team.ts against a WRITABLE api to fix)"
fi

echo "→ mint the phone-app reviewer bearer"
MOBILE_TOKEN=$(DATABASE_URL="postgres://postgres:postgres@127.0.0.1:56432/postgres" \
  pnpm -s -C server/web exec tsx ../../demo/seed/mint-mobile-token.ts | tail -1)
[ -n "$MOBILE_TOKEN" ] || { echo "✗ failed to mint the mobile token"; exit 1; }
echo "  minted (${#MOBILE_TOKEN} chars, never printed)"

echo "→ render the edge config"
mkdir -p "$ART/edge"
sed -e "s|__DEMO_TEAM__|$TEAM|" \
    -e "s|__DEMO_SESSION__|$SESSION|" \
    -e "s|__DEMO_MOBILE_TOKEN__|$MOBILE_TOKEN|" \
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

echo "→ UI ($DEMO_UI_IMAGE) on :$UI_PORT — this is where every screen lives"
# The published client image, run the way the site box runs it, with one
# difference: host networking, so that ONE origin can serve both callers of
# MANTLE_SERVER_ORIGIN. The variable is read twice — baked into /env.js for
# the BROWSER, and used by the client's own server-side fetches (appearance,
# the login mark). Both must reach the EDGE, never the API: point the browser
# at the API and it bypasses Caddy, gets no injected cookie, and every screen
# spins forever behind a 401 while the pages render fine. On the box the
# public URL resolves from both places; here the edge is a loopback port on
# THIS host, which only a host-networked container also sees as 127.0.0.1.
# The image's command binds :3000, so it is overridden to this bench's port.
#
# This used to build client/web from THIS checkout. That directory left with
# the split; the image is the client now, and a bench that runs it measures
# what a visitor gets rather than a build only this machine has.
docker rm -f mantle_demo_ui >/dev/null 2>&1 || true
docker pull -q "$DEMO_UI_IMAGE" >/dev/null 2>&1 || true   # a local image has nothing to pull
docker run -d --name mantle_demo_ui --network host \
  -e MANTLE_SERVER_ORIGIN="http://127.0.0.1:$EDGE_PORT" \
  -e MANTLE_TOUR="$DEMO_TOUR" \
  -e NODE_ENV=production \
  "$DEMO_UI_IMAGE" pnpm -C client/web exec next start -H 0.0.0.0 -p "$UI_PORT" >/dev/null
for i in $(seq 1 90); do
  curl -sf "http://127.0.0.1:$UI_PORT/env.js" >/dev/null 2>&1 && break
  sleep 1; [ "$i" = 90 ] && { echo "✗ UI not ready:"; docker logs mantle_demo_ui 2>&1 | tail -25; exit 1; }
done
echo "  ready ($(docker inspect -f '{{.Config.Image}}' mantle_demo_ui))"

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
   && [ "$(docker inspect -f '{{.State.Running}}' mantle_demo_ui 2>/dev/null)" = "true" ]; do sleep 5; done
echo "app exited — tearing down the UI and the edge"
