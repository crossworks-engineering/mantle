#!/bin/sh
# runs-on: box. The image build only (Linux, GNU tools), as the last step
# that needs Node in each run stage (Dockerfile, parser and server): POSIX sh.
#
# Node leaves the run image. It ran pnpm's install and the web build, and
# nothing in the image runs on it. pnpm stays the operator command
# (`docker exec ... pnpm -C ...`), and Bun runs it, with --no-env-file as
# every Bun start has. The base image's entrypoint goes too: it put `node` in
# front of any command it did not know (the stage sets `ENTRYPOINT []`).
# The wrapper starts the file the old pnpm link named (a pnpm that moves its
# entry fails here, not on a box), and the link is removed before the wrapper
# is written, so the write cannot go through it into pnpm itself.
set -eu
[ -L /usr/local/bin/pnpm ] || { echo "drop-node: /usr/local/bin/pnpm is not npm's link" >&2; exit 1; }
entry=$(readlink -f /usr/local/bin/pnpm)
[ -f "$entry" ] || { echo "drop-node: no pnpm entry at $entry" >&2; exit 1; }
rm -rf /usr/local/bin/node /usr/local/bin/nodejs /usr/local/bin/npm /usr/local/bin/npx \
  /usr/local/bin/corepack /usr/local/bin/docker-entrypoint.sh \
  /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/include/node \
  /usr/local/bin/pnpm /usr/local/bin/pnpx
printf '#!/bin/sh\nexec /usr/local/bin/bun --no-env-file %s "$@"\n' "$entry" > /usr/local/bin/pnpm
chmod 755 /usr/local/bin/pnpm
