#!/usr/bin/env bash
# Bring up Mantle dev infra (postgres + minio + tika), apply migrations, create
# the pg-boss schema, then run the dev servers. Idempotent — safe to run on a
# clean machine or against an already-running stack.
#
# Invoke via `pnpm start` (the canonical name). `pnpm up` is pnpm's built-in
# alias for `update`, so the script `up` is shadowed — `pnpm run up` works if
# you must, but `pnpm start` is friction-free.

set -euo pipefail

cd "$(dirname "$0")/.."

# ── 1. Docker daemon -------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  cat <<EOF >&2
Docker isn't running. Start Docker Desktop (or your engine) and re-run.
On macOS:  open -a Docker
EOF
  exit 1
fi

# ── 2. .env.local check ----------------------------------------------------
if [[ ! -f .env.local ]]; then
  cat <<EOF >&2
.env.local is missing. Copy .env.example to .env.local and fill it in:

  cp .env.example .env.local
  \$EDITOR .env.local

Required vars:
  DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54323/postgres
  MANTLE_MASTER_KEY=\$(openssl rand -base64 32)
EOF
  exit 1
fi

# ── 3. Bring up infra ------------------------------------------------------
echo "→ Bringing up postgres + minio (docker-compose.dev.yml)…"
docker compose -f docker-compose.dev.yml up -d --wait

# ── 4. Ensure MinIO bucket --------------------------------------------------
# Read S3 creds from .env.local so the bucket gets created with the same
# credentials the app uses. Defaults match docker-compose.dev.yml.
S3_ACCESS_KEY_VAL=$(grep -E '^S3_ACCESS_KEY=' apps/web/.env.local | head -1 | cut -d= -f2- || echo minio)
S3_SECRET_KEY_VAL=$(grep -E '^S3_SECRET_KEY=' apps/web/.env.local | head -1 | cut -d= -f2- || echo minio12345)
: "${S3_ACCESS_KEY_VAL:=minio}"
: "${S3_SECRET_KEY_VAL:=minio12345}"

echo "→ Ensuring MinIO bucket 'mantle' exists…"
docker run --rm --network mantle_default \
  -e ACCESS_KEY="$S3_ACCESS_KEY_VAL" \
  -e SECRET_KEY="$S3_SECRET_KEY_VAL" \
  --entrypoint sh \
  minio/mc -c '
    mc alias set local http://minio:9000 "$ACCESS_KEY" "$SECRET_KEY" >/dev/null
    mc mb -p local/mantle 2>/dev/null || true
    mc anonymous set none local/mantle >/dev/null
  ' || echo "  (bucket setup failed — proceeding, the app may auto-create)"

# ── 5. Migrations ----------------------------------------------------------
echo "→ Running Drizzle migrations…"
pnpm -C packages/db migrate

# ── 5b. pg-boss schema ------------------------------------------------------
# Create the `pgboss` schema deterministically BEFORE the dev servers start.
# Otherwise the email worker + agent extract-queue + backfill queue all call
# pg-boss `start()` at once on a fresh DB and race to create it — leaving the
# schema missing (a storm of `relation "pgboss.*" does not exist`). Idempotent.
echo "→ Ensuring pg-boss schema…"
pnpm -C apps/web pgboss:init

# ── 6. Dev servers ---------------------------------------------------------
echo "→ Starting dev servers…"
exec pnpm dev
