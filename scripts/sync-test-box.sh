#!/usr/bin/env bash
# Sync this working tree's source to a box's source-run stack (~/mantle-src,
# served by the docker-compose.dev-src.yml override — see that file on the
# box). Dev servers there hot-reload on sync; no image build.
#
#   scripts/sync-test-box.sh                # sync current tree → test box
#   scripts/sync-test-box.sh mantle-prod    # → another box running the override
#
# Box-local dirs (node_modules, .next, .pnpm-store, .env*) are excluded from
# --delete so a sync never clobbers the box's install or env.
set -euo pipefail
cd "$(dirname "$0")/.."
BOX="${1:-mantle-test}"

# sudo on the remote side: the source-run containers execute as root, so files
# they regenerate (public/app-runtime, .next) end up root-owned and would block
# an unprivileged overwrite.
exec rsync -az --delete --rsync-path="sudo rsync" \
  -e "ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes" \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude '.turbo' \
  --exclude '.pnpm-store' \
  --exclude '.env*' \
  --exclude 'hermes-agent' \
  --exclude '.claude' \
  --exclude 'data' \
  ./ "$BOX":~/mantle-src/
