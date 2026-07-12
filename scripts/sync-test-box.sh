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

# Root-owned files: the source-run containers execute as root, so files they
# regenerate (public/app-runtime, .next) end up root-owned and would block an
# unprivileged overwrite. On boxes with passwordless sudo we rsync as root;
# elsewhere a docker helper (cwe is in the docker group) chowns the tree back
# to the remote user first.
SSH="ssh -i $HOME/.ssh/id_ed25519 -o IdentitiesOnly=yes"
if $SSH "$BOX" 'sudo -n true' 2>/dev/null; then
  RSYNC_PATH="sudo rsync"
else
  $SSH "$BOX" 'docker run --rm -v "$HOME/mantle-src:/src" alpine sh -c "chown -R $(id -u):$(id -g) /src"'
  RSYNC_PATH="rsync"
fi

exec rsync -az --delete --rsync-path="$RSYNC_PATH" \
  -e "$SSH" \
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
