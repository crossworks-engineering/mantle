#!/usr/bin/env bash
set -euo pipefail
#
# build-ui.sh — build client/web as a self-contained standalone server and
# stage it into client/desktop/ui/ for the Electron shell to embed.
#
# The standalone tree mirrors the monorepo layout (server.js sits under
# client/web/ inside it); entry.json records where, so the shell's main
# process never hardcodes that shape.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ui="$root/client/desktop/ui"

echo "→ next build (standalone) in client/web"
cd "$root/client/web"
MANTLE_STANDALONE=1 pnpm build

echo "→ staging into client/desktop/ui"
rm -rf "$ui"
mkdir -p "$ui"
cp -a .next/standalone/. "$ui/"

server_js="$(cd "$ui" && find . -maxdepth 3 -name server.js -not -path '*/node_modules/*' | head -1)"
[ -n "$server_js" ] || { echo "✗ no server.js in standalone output" >&2; exit 1; }
app_dir="$ui/$(dirname "$server_js")"

# Static assets and public/ are not part of standalone output by design.
cp -a .next/static "$app_dir/.next/static"
cp -a public "$app_dir/public"

node -e "require('fs').writeFileSync('$ui/entry.json', JSON.stringify({ server: process.argv[1].replace(/^\.\//, '') }, null, 2))" "$server_js"
echo "✓ embedded UI staged ($(du -sh "$ui" | cut -f1)) — entry: $server_js"
