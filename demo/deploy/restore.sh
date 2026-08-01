#!/usr/bin/env bash
# Restore a packed demo brain and bring the stack up. Runs ON THE BOX, from
# inside the unpacked bundle directory.
#
#   ./restore.sh              restore into an empty stack, then start the app
#   ./restore.sh --force      allow restoring OVER an existing demo brain
#   ./restore.sh --no-start   restore and verify, but leave the app down
#
# Refuses to start the app unless the restored database matches the counts the
# bundle was packed with. That gate exists because every way this deploy has
# failed so far has looked healthy: hollow tables, unsearchable files and
# 404ing help panels all render a perfectly good screen.
set -euo pipefail
cd "$(dirname "$0")"
BUNDLE="$(pwd)"

FORCE=0; START=1
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --no-start) START=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

COMPOSE=(docker compose -f "$BUNDLE/docker-compose.demo.yml" --env-file "$BUNDLE/.env.demo")
PG=mantle_demo_srv_pg
fail() { echo "✗ $1" >&2; exit 1; }
manifest() { grep -E "^$1 " "$BUNDLE/manifest.txt" | awk '{print $2}'; }

echo "→ preflight"
[ -f "$BUNDLE/manifest.txt" ] || fail "no manifest.txt — is this an unpacked bundle?"
[ -f "$BUNDLE/.env.demo" ] || fail "no .env.demo — copy .env.demo.example and fill in SESSION_SECRET, MANTLE_MASTER_KEY and MANTLE_PUBLIC_URL"

# The two seals. Wrong values do not error, they just make every visitor meet a
# login screen (session) or leave the vault shut (master key), so check they are
# at least present before spending ten minutes on a restore.
for v in SESSION_SECRET MANTLE_MASTER_KEY MANTLE_PUBLIC_URL; do
  grep -qE "^$v=.+" "$BUNDLE/.env.demo" || fail "$v is empty in .env.demo"
done

echo "  bundle:   $(manifest app_version) · $(manifest git_sha) · packed $(manifest packed_at)"
echo "  embedder: $(grep -E '^embedder ' "$BUNDLE/manifest.txt" | cut -d' ' -f2-)"

echo "→ verifying the bundle survived the trip"
( cd "$BUNDLE" && sha256sum --quiet -c checksums.sha256 ) || fail "checksum mismatch — re-copy the bundle"
echo "  checksums ok"

# The five payloads are bind-mounted straight out of the bundle, so the bundle
# directory IS the demo's data root from here on. All absolute.
export DEMO_DOCS_ROOT="$BUNDLE/docs"
export DEMO_FILES_ROOT="$BUNDLE/files"
export DEMO_TABLE_DB_DIR="$BUNDLE/table-dbs"
export DEMO_DATA_DIR="$BUNDLE/data"
# Deliberately empty: the dump carries its own CREATE EXTENSION and its own
# auth schema, so a fresh cluster needs no init scripts and running them first
# only gives pg_restore objects to collide with.
export DEMO_PG_INIT_DIR="$BUNDLE/.no-init"
mkdir -p "$DEMO_PG_INIT_DIR" "$DEMO_DATA_DIR"

# PERSIST them into .env.demo, don't just export. Exporting makes the paths
# correct for exactly one process: this one. The next `docker compose up` —
# a restart, an image bump, someone's ssh session — would resolve them again,
# and before they were `:?` required that meant a relative default pointing
# somewhere else entirely. On this box that silently initialised an EMPTY
# postgres cluster: every container healthy, every query answering
# "password authentication failed for demo_reader", search returning nothing.
# Writing them here makes the bundle self-describing, so there is only ever
# one answer to where the data lives.
if ! grep -q '^DEMO_DATA_DIR=' "$BUNDLE/.env.demo"; then
  cat >> "$BUNDLE/.env.demo" <<EOF

# Written by restore.sh — absolute paths to this bundle's five payloads.
# Do not make these relative: compose resolves relative paths against the
# compose file's directory, not your shell's.
DEMO_DATA_DIR=$DEMO_DATA_DIR
DEMO_DOCS_ROOT=$DEMO_DOCS_ROOT
DEMO_FILES_ROOT=$DEMO_FILES_ROOT
DEMO_TABLE_DB_DIR=$DEMO_TABLE_DB_DIR
DEMO_PG_INIT_DIR=$DEMO_PG_INIT_DIR
EOF
  echo "  wrote the five data paths into .env.demo"
fi

echo "→ infrastructure"
# createbucket is deliberately NOT in the --wait set. `up --wait` waits for
# every named service to be running-or-healthy, and a one-shot that exits 0 is
# neither — so including it makes the command fail on success. Wait for the
# long-lived pair, then run the one-shot and check its exit code directly.
"${COMPOSE[@]}" up -d --wait postgres minio
"${COMPOSE[@]}" up -d createbucket >/dev/null
BUCKET_RC=$(docker wait mantle_demo_srv_createbucket)
[ "$BUCKET_RC" = "0" ] || fail "createbucket exited $BUCKET_RC — the app only HEADs the bucket and never creates it"
echo "  postgres + minio healthy, bucket ready"

# Restoring over a populated brain silently doubles content or half-fails on
# conflicts. Make it a decision, not an accident.
EXISTING=$(docker exec "$PG" psql -U postgres -d postgres -tAc \
  "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null || echo 0)
if [ "${EXISTING:-0}" -gt 0 ] && [ "$FORCE" -eq 0 ]; then
  fail "this stack already has $EXISTING public tables — re-run with --force to restore over it"
fi

echo "→ restoring the brain"
# Always restore into an EMPTY database — drop and recreate it rather than
# leaning on pg_restore --clean. --clean cannot drop pgboss's per-day partition
# constraints ("cannot drop inherited constraint job_common_pkey"), so it works
# on a virgin cluster and fails on every re-run, which is the worst possible
# split: the path you test is not the path you repeat. One target state, one
# code path.
if [ "$FORCE" -eq 1 ]; then
  # Anything still holding a connection blocks the drop — the app first, then
  # any stragglers.
  "${COMPOSE[@]}" stop web client >/dev/null 2>&1 || true
  docker exec "$PG" psql -U postgres -d template1 -tAc \
    "select pg_terminate_backend(pid) from pg_stat_activity where datname='postgres' and pid <> pg_backend_pid()" >/dev/null
fi
docker exec "$PG" psql -U postgres -d template1 -q -v ON_ERROR_STOP=1 \
  -c "drop database if exists postgres" -c "create database postgres"

RESTORE_LOG="$BUNDLE/restore.log"
set +e
docker exec -i "$PG" pg_restore -U postgres -d postgres \
  --no-owner --no-privileges < "$BUNDLE/brain.dump" 2> "$RESTORE_LOG"
set -e
ERRS=$(grep -c "^pg_restore: error" "$RESTORE_LOG" || true)
if [ "${ERRS:-0}" -gt 0 ]; then
  echo "  ⚠ pg_restore reported $ERRS error(s) — see $RESTORE_LOG"
  grep "^pg_restore: error" "$RESTORE_LOG" | head -5 >&2
  fail "restore incomplete"
fi
echo "  restored clean"

# AFTER the restore, never before: the grants have to attach to the schema that
# actually landed. This is also why the dump is taken --no-privileges.
echo "→ read-only role"
docker exec -i "$PG" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 < "$BUNDLE/readonly-role.sql"
echo "  demo_reader ready"

echo "→ object store"
MC_NET=$(docker inspect mantle_demo_srv_minio --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')
docker run --rm --network "$MC_NET" -v "$BUNDLE/minio:/in:ro" --entrypoint sh \
  minio/mc:RELEASE.2025-08-13T08-35-41Z -c \
  "mc alias set l http://minio:9000 \${S3_ACCESS_KEY:-minio} \${S3_SECRET_KEY:-minio12345} >/dev/null && mc mirror --quiet --overwrite /in l/mantle" >/dev/null
echo "  $(manifest minio_objects) object(s) mirrored"

echo "→ verifying the restore against the manifest"
q() { docker exec "$PG" psql -U postgres -d postgres -tAc "$1"; }
check() { # name expected actual
  if [ "$2" = "$3" ]; then printf '  ✓ %-16s %s\n' "$1" "$3"
  else printf '  ✗ %-16s expected %s, got %s\n' "$1" "$2" "$3"; BAD=1; fi
}
BAD=0
check vec_nodes      "$(manifest vec_nodes)"      "$(q "select count(*) from nodes where embedding is not null")"
check vec_chunks     "$(manifest vec_chunks)"     "$(q "select count(*) from content_chunks where embedding is not null")"
check vec_facts_live "$(manifest vec_facts_live)" "$(q "select count(*) from facts where embedding is not null and valid_to is null")"
check vec_entities   "$(manifest vec_entities)"   "$(q "select count(*) from entities where embedding is not null")"
check table_nodes    "$(manifest table_nodes)"    "$(q "select count(*) from nodes where type = 'table'")"
check file_nodes     "$(manifest file_nodes)"     "$(q "select count(*) from nodes where type = 'file'")"

# The three on-disk roots, checked here rather than trusted: they are bind
# mounts, and a mount that silently resolved to an empty directory is exactly
# how the tables and the help panels break.
check table_workbooks "$(manifest table_workbooks)" "$(find "$DEMO_TABLE_DB_DIR" -name '*.sqlite' ! -name '*.draft.sqlite' | wc -l | tr -d ' ')"
check file_bytes      "$(manifest file_bytes)"      "$(find "$DEMO_FILES_ROOT" -type f | wc -l | tr -d ' ')"
check help_topics     "$(manifest help_topics)"     "$(find "$DEMO_DOCS_ROOT/guide/06-help" -name '*.md' | wc -l | tr -d ' ')"

# The embedder config travels inside the dump. Empty here means the brain would
# fall back to a local embedder this box does not run — a dead search box, with
# every screen still rendering.
EMB=$(q "select model || ' · ' || dimensions || 'd · ' || primary_provider from embedding_config")
[ -n "$EMB" ] || { echo "  ✗ embedding_config is empty after restore"; BAD=1; }
[ -n "$EMB" ] && echo "  ✓ embedder          $EMB"

[ "$BAD" -eq 0 ] || fail "the restored brain does not match the bundle — not starting the app"

if [ "$START" -eq 0 ]; then
  echo; echo "✓ restored and verified. App left down (--no-start)."
  exit 0
fi

echo "→ starting the app"
"${COMPOSE[@]}" up -d --wait web client
echo

cat <<EOF
✓ demo restored and running.

  Both gates, against the REAL url — not localhost. The first proves the
  read-only claim, the second walks all 95 routes in a real browser and
  measures rendered text inside the content region:

      demo/scripts/check-readonly.sh $(grep '^MANTLE_PUBLIC_URL=' "$BUNDLE/.env.demo" | cut -d= -f2-)
      demo/scripts/check-routes.sh   $(grep '^MANTLE_PUBLIC_URL=' "$BUNDLE/.env.demo" | cut -d= -f2-)

  Then a semantic search, which no route sweep can check for you — use a
  paraphrase of content you know is there, not a plausible-sounding question:

      /api/search?q=documents+sent+to+contractors+for+pricing
      → should surface the transmittals

  Do not link the demo from the site header until all three are green.
  That is exactly how v1 shipped 85 blank screens.
EOF
