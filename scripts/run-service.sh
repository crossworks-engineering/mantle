#!/bin/sh
# runs-on: both. Linux boxes, inside the server image (the command of each
# service in docker-compose.yml, and the image's default CMD), and the Mac
# through the boot smoke: POSIX sh, keep it BSD-tool safe.
#
#   scripts/run-service.sh <package dir> <entry file>
#
# Starts one service on the runtime MANTLE_RUNTIME names: node (the default:
# node itself with tsx's loader, in the package's folder), or bun (Bun starts
# the entry itself, with --no-env-file: compose gives the environment, and Bun
# must not read a .env beside the code). A box moves with one line in .env,
# MANTLE_RUNTIME=bun, then `up -d`; it moves back the same way. exec: the
# runtime takes this process's place, so a stop signal reaches it, and no
# pnpm or tsx process stays above it (each cost about 100 MB at rest, and
# `pnpm start` quit 1.4 s into the API's drain). Compose gives each of these
# services `init: true`: tini is PID 1, so a stop during boot, before the
# service has a handler, still ends at once.
set -eu
[ $# -eq 2 ] || { echo "run-service: usage: run-service.sh <package dir> <entry file>" >&2; exit 2; }
case "${MANTLE_RUNTIME:-node}" in
  node) cd "$1" && exec node --import tsx "$2" ;;
  bun) cd "$1" && exec bun --no-env-file "$2" ;;
  *)
    echo "run-service: MANTLE_RUNTIME must be node or bun, not '${MANTLE_RUNTIME}'" >&2
    exit 2
    ;;
esac
