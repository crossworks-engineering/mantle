#!/usr/bin/env bash
set -euo pipefail
#
# build-ui.sh — build client/web as a self-contained standalone server and
# stage it into client/desktop/ui/ for the Electron shell to embed.
#
# The standalone tree mirrors the monorepo layout (server.js sits under
# client/web/ inside it); entry.json records where, so the shell's main
# process never hardcodes that shape.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # resolved BEFORE any cd below
root="$(cd "$here/../../.." && pwd)"
ui="$root/client/desktop/ui"

echo "→ next build (standalone) in client/web"
cd "$root/client/web"
MANTLE_STANDALONE=1 pnpm build

echo "→ staging into client/desktop/ui"
rm -rf "$ui"
mkdir -p "$ui"

# Copy through node, DEREFERENCING every symlink, rather than `cp -a`.
#
# Next's standalone output is mostly symlinks into the pnpm store. `cp -a`
# preserves them, which fails outright on Windows — creating a symlink there
# needs Developer Mode or an elevated shell, so every link errored and the
# desktop build died at this line:
#
#   cp: cannot create symbolic link '…/ui/./client/web/node_modules/next'
#
# Dereferencing is also more correct on every platform: this tree is about to be
# packaged into an app that ships to a machine with no pnpm store, so a link
# pointing back at this checkout is dead weight at best.
#
# A hand-written walk rather than a flag — `fs.cpSync`'s `dereference` misses
# nested links, and `cp -RL` / `tar -ch` both trip over the one dangling link
# this tree contains. See the header of stage-copy.mjs for the evidence.
copy_tree() { node "$here/stage-copy.mjs" "$1" "$2"; }

copy_tree .next/standalone "$ui"

server_js="$(cd "$ui" && find . -maxdepth 3 -name server.js -not -path '*/node_modules/*' | head -1)"
[ -n "$server_js" ] || { echo "✗ no server.js in standalone output" >&2; exit 1; }
app_dir="$ui/$(dirname "$server_js")"

# Static assets and public/ are not part of standalone output by design.
copy_tree .next/static "$app_dir/.next/static"
copy_tree public "$app_dir/public"

node -e "require('fs').writeFileSync('$ui/entry.json', JSON.stringify({ server: process.argv[1].replace(/^\.\//, '') }, null, 2))" "$server_js"
echo "✓ embedded UI staged ($(du -sh "$ui" | cut -f1)) — entry: $server_js"
