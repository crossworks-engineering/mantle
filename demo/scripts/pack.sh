#!/usr/bin/env bash
# Pack the seeded brain into ONE bundle the site box can restore.
#
#   demo/scripts/pack.sh              → demo/.run/bundle/mantle-demo-<ver>-<sha>.tar.gz
#   demo/scripts/pack.sh --out DIR    → somewhere else
#
# A deploy that carries only the database gets hollow tables, unsearchable
# files and 404ing help panels. Five things travel, and this script is the
# thing that guarantees all five leave together:
#
#   brain.dump      pg_dump of mantle_demo_pg
#   minio/          the `mantle` bucket (small — attachments only)
#   table-dbs/      SQLite workbooks. Postgres holds only the registry that
#                   POINTS at these; a mismatch is TableFileMissingError on
#                   every table
#   files/          file BYTES. Not in the database, not in MinIO
#   docs/           generated demo docs + guide/06-help, both read from disk at
#                   request time
#
# Plus everything needed to stand it up: the compose, the read-only role, the
# postgres init scripts, the env example, and restore.sh itself.
#
# EVERY CHECK BELOW IS A BUG THAT ALREADY HAPPENED. None of them are hypothetical
# and none should be skipped to "just get a bundle out" — a bundle that packs
# clean is the only evidence the deploy will not repeat one of them.
set -euo pipefail
cd "$(dirname "$0")/../.."
DEMO="demo"; ART="$DEMO/.run"

OUT="$ART/bundle"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

PG_CONTAINER="mantle_demo_pg"
MINIO_CONTAINER="mantle_demo_minio"
OWNER_URL="postgres://postgres:postgres@127.0.0.1:56432/postgres"
DOCS_ROOT="$DEMO/generator/out/docs"
TABLE_DBS="$ART/table-dbs"
FILES="$ART/files"

VERSION=$(node -p "require('./package.json').version")
SHA=$(git rev-parse --short HEAD)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NAME="mantle-demo-v$VERSION-$SHA"
STAGE="$ART/pack-stage"

psql_owner() { docker exec -i "$PG_CONTAINER" psql -U postgres -d postgres -tAc "$1"; }
fail() { echo "✗ $1" >&2; exit 1; }

echo "→ preflight"

# The seed stack has to be UP: the dump comes out of the running container so
# the pg_dump client is the same build as the server. Dumping with whatever
# client the host happens to have is the version-skew failure this fleet has
# already been bitten by.
docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null | grep -q true \
  || fail "$PG_CONTAINER is not running — demo/scripts/stack-up.sh first"
docker inspect -f '{{.State.Running}}' "$MINIO_CONTAINER" 2>/dev/null | grep -q true \
  || fail "$MINIO_CONTAINER is not running — demo/scripts/stack-up.sh first"
PG_SERVER=$(psql_owner "show server_version" | cut -d. -f1)
echo "  postgres $PG_SERVER (dumping with its own client — no skew)"

# THE check that matters most, and the one with no visible symptom if it fails.
# An empty embedding_config means the resolver falls back to the LOCAL embedder
# (embeddinggemma via Ollama), which the serve box does not run — so search
# would degrade or die there while looking perfectly healthy here.
EMB=$(psql_owner "select model || ' · ' || dimensions || 'd · ' || primary_provider from embedding_config" || true)
[ -n "$EMB" ] || fail "embedding_config is EMPTY — the brain would serve on the local fallback the site box does not run. See demo/deploy/README-embedder.md"
echo "  embedder: $EMB"
psql_owner "select primary_api_key_id is not null from embedding_config" | grep -q t \
  || fail "the embedding config names no API key — an online embedder without a key is a dead search box"

# Vector counts, recorded into the manifest so restore can prove nothing was
# lost in transit. Also a smoke test that the re-embed actually ran.
NODES=$(psql_owner "select count(*) from nodes where embedding is not null")
CHUNKS=$(psql_owner "select count(*) from content_chunks where embedding is not null")
FACTS=$(psql_owner "select count(*) from facts where embedding is not null and valid_to is null")
ENTITIES=$(psql_owner "select count(*) from entities where embedding is not null")
echo "  vectors: $NODES nodes · $CHUNKS chunks · $FACTS live facts · $ENTITIES entities"
[ "$CHUNKS" -gt 0 ] || fail "no content_chunks carry a vector — passage search would be empty"

# Table workbooks vs the registry that points at them. Postgres stores only the
# path; if the counts disagree the tables 500 with TableFileMissingError on the
# box and nowhere else, because here the files happen to be present.
REG=$(psql_owner "select count(*) from nodes where type = 'table'")
WB=$(find "$TABLE_DBS" -name '*.sqlite' ! -name '*.draft.sqlite' 2>/dev/null | wc -l | tr -d ' ')
[ "$WB" -ge "$REG" ] || fail "$REG table nodes registered but only $WB workbooks on disk in $TABLE_DBS — the registry and the files have diverged"
echo "  tables: $REG registered · $WB workbooks"

# File bytes. The silent one: files ingest as nodes with a title and nothing
# else when the root is wrong — no text, no chunks, no error anywhere.
FCOUNT=$(find "$FILES" -type f 2>/dev/null | wc -l | tr -d ' ')
[ "$FCOUNT" -gt 0 ] || fail "no file bytes in $FILES — see the MANTLE_FILES_ROOT note in demo/scripts/serve.sh"
INDEXED=$(psql_owner "select count(*) from nodes where type = 'file'")
echo "  files: $FCOUNT bytes on disk · $INDEXED file nodes"

# Two different things live under the docs root and BOTH are read from disk at
# request time. Missing help topics produce a 404 behind every "?" panel while
# every screen still renders — invisible to a route sweep.
[ -d "$DOCS_ROOT" ] || fail "$DOCS_ROOT missing — run node demo/generator/gen.mjs (deterministic)"
mkdir -p "$DOCS_ROOT/guide"
cp -a docs/guide/06-help "$DOCS_ROOT/guide/"
HELP=$(find "$DOCS_ROOT/guide/06-help" -name '*.md' | wc -l | tr -d ' ')
MD=$(find "$DOCS_ROOT" -name '*.md' | wc -l | tr -d ' ')
[ "$HELP" -gt 0 ] || fail "no help topics under $DOCS_ROOT/guide/06-help — every \"?\" panel would 404"
echo "  docs: $MD markdown · $HELP help topics"

echo "→ staging"
rm -rf "$STAGE"; mkdir -p "$STAGE/$NAME"
B="$STAGE/$NAME"

# Custom format: parallel-restorable, compressed, and `pg_restore --list` can
# describe it without a database. Taken through the container's own client.
echo "  brain.dump"
docker exec "$PG_CONTAINER" pg_dump -U postgres -d postgres -Fc --no-owner --no-privileges > "$B/brain.dump"

# --no-privileges is deliberate: the dump must NOT carry demo_reader's grants.
# The role is created fresh on the box AFTER the restore, so the grants match
# the schema that actually landed rather than the one that was dumped.

echo "  minio/"
mkdir -p "$B/minio"
# --user: mc runs as root by default and would leave the mirrored objects
# root-owned on the host, so the staging directory could not be cleaned up
# (or re-packed) without sudo.
docker run --rm --network "$(docker inspect "$MINIO_CONTAINER" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')" \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$(cd "$B/minio" && pwd):/out" --entrypoint sh \
  minio/mc:RELEASE.2025-08-13T08-35-41Z -c \
  "mc alias set l http://minio:9000 minio minio12345 >/dev/null && mc mirror --quiet --overwrite l/mantle /out" >/dev/null
OBJ=$(find "$B/minio" -type f | wc -l | tr -d ' ')
echo "    $OBJ objects"

echo "  table-dbs/ · files/ · docs/"
cp -a "$TABLE_DBS" "$B/table-dbs"
cp -a "$FILES" "$B/files"
cp -a "$DOCS_ROOT" "$B/docs"

echo "  deploy files"
cp -a "$DEMO/deploy/docker-compose.demo.yml" "$B/"
cp -a "$DEMO/deploy/readonly-role.sql" "$B/"
cp -a "$DEMO/deploy/.env.demo.example" "$B/"
cp -a "$DEMO/deploy/README-embedder.md" "$B/"
cp -a "$DEMO/deploy/restore.sh" "$B/" 2>/dev/null || echo "    ⚠ restore.sh not found — bundle will need it copied in by hand"
cp -a infra/postgres/init "$B/postgres-init"

# Provenance + the counts restore will re-check. Written before the checksums
# so the manifest itself is covered by nothing — deliberately: it is the
# statement OF the checksums, not one of them.
cat > "$B/manifest.txt" <<EOF
# Mantle demo bundle — restore with ./restore.sh
packed_at        $STAMP
packed_from      $(hostname)
app_version      v$VERSION
git_sha          $SHA
git_branch       $(git rev-parse --abbrev-ref HEAD)
postgres_major   $PG_SERVER
embedder         $EMB

# restore.sh re-counts these against the restored database and refuses to
# start the app if any of them moved.
vec_nodes        $NODES
vec_chunks       $CHUNKS
vec_facts_live   $FACTS
vec_entities     $ENTITIES
table_nodes      $REG
table_workbooks  $WB
file_nodes       $INDEXED
file_bytes       $FCOUNT
minio_objects    $OBJ
docs_markdown    $MD
help_topics      $HELP
EOF

( cd "$B" && find . -type f ! -name checksums.sha256 -print0 | sort -z | xargs -0 sha256sum > checksums.sha256 )

echo "→ archiving"
mkdir -p "$OUT"
TARBALL="$OUT/$NAME.tar.gz"
tar -czf "$TARBALL" -C "$STAGE" "$NAME"
rm -rf "$STAGE"
sha256sum "$TARBALL" > "$TARBALL.sha256"

echo
echo "✓ $TARBALL"
echo "  $(du -h "$TARBALL" | cut -f1) · sha256 $(cut -c1-16 < "$TARBALL.sha256")…"
echo
echo "  The dump carries the vault — api_keys.key_enc, encrypted under"
echo "  MANTLE_MASTER_KEY. Treat this file as a secret and do not commit it."
echo
echo "  Next:  scp $TARBALL cwe@mantle-ai.tech:~/"
echo "         ssh cwe@mantle-ai.tech 'tar -xzf $NAME.tar.gz && cd $NAME && ./restore.sh'"
