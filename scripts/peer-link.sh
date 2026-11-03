#!/usr/bin/env bash
# runs-on: both. Linux boxes, and the Mac through the deploy-scripts harness: keep it bash 3.2 and BSD-tool safe.
# ─────────────────────────────────────────────────────────────────────────────
# scripts/peer-link.sh: link this box to another one from the shell, with no
# password and no UI: the status link of the fleet monitor
# (docs/federation.md "Status links").
#
# Runs server/web/scripts/peer-link.ts inside the web container. Shell access
# to this box proves you own it, as with scripts/onboard.sh, so it asks for
# no password: the peers it makes are the brain owner's.
#
#   scripts/peer-link.sh create --name admin --url https://admin.example.com --status-only
#   scripts/peer-link.sh create --name box1 --url https://box1.example.com --outbound-only --watch
#   scripts/peer-link.sh accept --peer box1 --token-file ./box1-token
#   ssh box1 'cat token' | scripts/peer-link.sh accept --peer box1
#   scripts/peer-link.sh list
#   scripts/peer-link.sh revoke --peer box1
#
# A create prints `peer_id=...` and, unless --outbound-only, this side's new
# token ONCE as `token=...` on stdout (notes go to stderr). The other box's
# token is read from a FILE here or from stdin, and piped to the container
# on stdin. Never as an argument: argv lands in shell history and in `ps`.
# Delete token files afterwards.
#
# Ships in the deploy bundle and is refreshed by the updater like the other
# operator scripts: its name is part of the fingerprint in
# infra/updater/updater.sh SCRIPT_NAMES and server/web/lib/updates.ts.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

# A token file given as a relative path means relative to where the operator
# ran this, so it is made absolute BEFORE the cd to the stack dir below.
abs_path() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$(pwd -P)" "$1" ;; esac; }
need_value() { # <flag> <value>: a flag given last, or with an empty value, is an error, not a silent exit
  [[ -n "$2" ]] || die "$1 needs a path, for example: $1 ./token.txt"
}
TOKEN_FILE=""; ARGS=()
while [[ $# -gt 0 ]]; do case "$1" in
  --token-file) need_value "$1" "${2:-}"; TOKEN_FILE="$(abs_path "$2")"; shift 2 ;;
  --token-file=*) need_value --token-file "${1#*=}"; TOKEN_FILE="$(abs_path "${1#*=}")"; shift ;;
  *) ARGS+=("$1"); shift ;;
esac; done

cd "$(dirname "$0")/.."

command -v docker >/dev/null 2>&1 || die "Docker isn't installed here. Run this on the box that runs the brain."
[[ -f docker-compose.yml ]] || die "No docker-compose.yml in $(pwd). Run this from the stack directory's scripts/."
# Compose run from the stack dir reads its .env (COMPOSE_FILE, the core shape
# included), so this is the same project the installer brought up.
COMPOSE=(docker compose)
CLI=(pnpm -C server/web exec tsx scripts/peer-link.ts)

"${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx web \
  || die "The web service isn't running. Bring the stack up first: docker compose up -d --wait"

if [[ -n "$TOKEN_FILE" ]]; then
  [[ -r "$TOKEN_FILE" ]] || die "Can't read the token file: $TOKEN_FILE"
  # Its first line on the container's stdin: the token never appears in any
  # process's argv.
  head -n 1 "$TOKEN_FILE" | "${COMPOSE[@]}" exec -T web "${CLI[@]}" ${ARGS[@]+"${ARGS[@]}"}
else
  # stdin passes through (a piped token for accept); -T: no terminal is
  # needed, every line of output is machine-readable.
  exec "${COMPOSE[@]}" exec -T web "${CLI[@]}" ${ARGS[@]+"${ARGS[@]}"}
fi
