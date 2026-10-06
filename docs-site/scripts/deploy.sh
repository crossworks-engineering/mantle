#!/usr/bin/env bash
# Build the docs site and deploy its files to the box that serves
# mantle-ai.tech.
#
#   DOCS_DEPLOY_HOST=<user@host> ./scripts/deploy.sh            build + rsync
#   DOCS_DEPLOY_HOST=<user@host> ./scripts/deploy.sh --no-build push dist/ as is
#
# This folder owns only the files. The shared Caddy (the docs.mantle-ai.tech
# vhost, TLS, the /srv/docs bind mount) belongs to the mantle-site repo; see
# its DEPLOY.md. A content deploy needs no Caddy reload: Caddy reads
# ~/mantle-docs/site live. The ssh login is not in this public repo; it is in
# mantle-site's DEPLOY.md.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${DOCS_DEPLOY_HOST:?set DOCS_DEPLOY_HOST to the site box ssh login (see mantle-site DEPLOY.md)}"

if [[ "${1:-}" != "--no-build" ]]; then
  pnpm install --frozen-lockfile
  pnpm build
fi

[[ -f dist/index.html ]] || { echo "dist/index.html missing: build failed?" >&2; exit 1; }

ssh "$HOST" "mkdir -p ~/mantle-docs/site"
rsync -az --delete dist/ "$HOST:~/mantle-docs/site/"

echo "Deployed to https://docs.mantle-ai.tech"
