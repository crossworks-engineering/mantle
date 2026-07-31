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

# EVERY path handed to node below is RELATIVE to the repo root, and that is
# load-bearing on Windows. Git Bash reports absolute paths POSIX-style
# (/d/a/mantle/…); node on Windows reads a leading slash as drive-RELATIVE, so
# the same string became D:\d\a\mantle\… and the build died writing
# entry.json to a directory that had never existed. Relative paths mean the two
# agree, with no cygpath dependency.
cd "$root"

ui_rel="client/desktop/ui"
web_rel="client/web"

# Structure is PRESERVED and directory links recreated as junctions — see the
# header of stage-copy.mjs for why dereferencing looks right and breaks the
# staged server on boot.
copy_tree() { node "client/desktop/scripts/stage-copy.mjs" "$1" "$2"; }

copy_tree "$web_rel/.next/standalone" "$ui_rel"

server_js="$(cd "$ui" && find . -maxdepth 3 -name server.js -not -path '*/node_modules/*' | head -1)"
[ -n "$server_js" ] || { echo "✗ no server.js in standalone output" >&2; exit 1; }
app_rel="$ui_rel/$(dirname "$server_js")"

# Static assets and public/ are not part of standalone output by design.
copy_tree "$web_rel/.next/static" "$app_rel/.next/static"
copy_tree "$web_rel/public" "$app_rel/public"

node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({ server: process.argv[2].replace(/^\.\//, '') }, null, 2))" \
  "$ui_rel/entry.json" "$server_js"
echo "✓ embedded UI staged ($(du -sh "$ui" | cut -f1)) — entry: $server_js"
