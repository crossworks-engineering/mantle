#!/usr/bin/env bash
# Bring up the demo seed/test stack: preflight → up --wait → one-shot setup.
# One command, idempotent — re-running against a live demo stack is fine
# (compose reconciles; the setup one-shots are no-ops).
set -euo pipefail
cd "$(dirname "$0")/.."

# A LIVE demo stack is allowed (idempotent re-run); anything else in the way
# is not. Preflight distinguishes: it only fails on ports/names that are
# taken by something that is NOT this compose project.
if docker compose ps --quiet 2>/dev/null | grep -q .; then
  echo "· demo stack already has running services — reconciling"
else
  scripts/preflight.sh
fi

# objectstore pulls its one-shot (objectstore_init) in through depends_on. It
# is deliberately NOT named here: `up --wait` waits for every service it names
# to be running or healthy, and a one-shot that exits 0 is neither.
docker compose up -d --wait postgres objectstore tika ollama

# One-shot (profile "setup" keeps it out of `up`'s default set). The bucket is
# not made here: seed.sh creates it after the migrations (objectstore:ensure).
docker compose --profile setup run --rm ollama_pull

echo
docker compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'
echo
echo "✓ demo stack up:"
echo "    postgres  127.0.0.1:56432   (postgres/postgres)"
echo "    rustfs    127.0.0.1:56900   (S3 API; keys minio/minio12345; seed.sh makes the bucket)"
echo "    tika      127.0.0.1:56998"
echo "    ollama    127.0.0.1:56434   (embeddinggemma pulled)"
