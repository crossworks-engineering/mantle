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

docker compose up -d --wait postgres minio tika ollama

# One-shots (profile "setup" keeps them out of `up`'s default set):
docker compose --profile setup run --rm createbucket
docker compose --profile setup run --rm ollama_pull

echo
docker compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'
echo
echo "✓ demo stack up:"
echo "    postgres  127.0.0.1:56432   (postgres/postgres)"
echo "    minio     127.0.0.1:56900   (minio/minio12345, bucket 'mantle')"
echo "    tika      127.0.0.1:56998"
echo "    ollama    127.0.0.1:56434   (embeddinggemma pulled)"
