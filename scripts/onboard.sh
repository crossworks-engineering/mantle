#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/onboard.sh: create the owner and finish first-run setup from the
# terminal, on a brain with no owner web UI (installed with --no-client).
#
# Runs server/web/scripts/onboard.ts inside the web container, so it uses the
# brain's own onboarding steps (the ones every Jackdaw client drives). Shell
# access to this box proves you own it, so it does not ask for the setup code.
# A run can stop at any point; the next run, or any Jackdaw client, picks up
# where it left off.
#
#   scripts/onboard.sh                                  # interactive
#   scripts/onboard.sh --yes --email you@example.com \
#       --password-file ./pw --key-file ./openrouter-key   # unattended
#
# Secrets (the owner password, the OpenRouter key) are typed hidden, or read
# from FILES here and piped to the container on stdin. Never as arguments:
# argv lands in shell history and in `ps`. Delete the files afterwards.
#
# Ships in the deploy bundle and is refreshed by the updater like the other
# operator scripts: its name is part of the fingerprint in
# infra/updater/updater.sh SCRIPT_NAMES and server/web/lib/updates.ts.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
scripts/onboard.sh [options]

Create the owner and finish setup on a headless brain. Every prompt has a
default; press Enter to take it.

Options (this wrapper):
  --password-file <path>   Read the owner password from a file (first line)
  --key-file <path>        Read the OpenRouter key from a file (first line)
  -h, --help               This help, then the wizard's own flags

Everything else passes through to the wizard: --yes, --email, --name,
--timezone, --locale, --assistant-model, --worker-model, --embedding-model,
--archetype, --purpose, --persona, --gender, --assistant-name.
EOF
}

# A secret file given as a relative path means relative to where the operator
# ran this, so it is made absolute BEFORE the cd to the stack dir below.
abs_path() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$(pwd -P)" "$1" ;; esac; }
need_value() { # <flag> <value>: a flag given last, or with an empty value, is an error, not a silent exit
  [[ -n "$2" ]] || die "$1 needs a path, for example: $1 ./secret.txt"
}
PASS_FILE=""; KEY_FILE=""; HELP=0; ARGS=()
while [[ $# -gt 0 ]]; do case "$1" in
  --password-file|--key-file)
    need_value "$1" "${2:-}"
    if [[ "$1" == --password-file ]]; then PASS_FILE="$(abs_path "$2")"; else KEY_FILE="$(abs_path "$2")"; fi
    shift 2 ;;
  --password-file=*) need_value --password-file "${1#*=}"; PASS_FILE="$(abs_path "${1#*=}")"; shift ;;
  --key-file=*) need_value --key-file "${1#*=}"; KEY_FILE="$(abs_path "${1#*=}")"; shift ;;
  -h|--help) HELP=1; shift ;;
  *) ARGS+=("$1"); shift ;;
esac; done

cd "$(dirname "$0")/.."

command -v docker >/dev/null 2>&1 || die "Docker isn't installed here. Run this on the box that runs the brain."
[[ -f docker-compose.yml ]] || die "No docker-compose.yml in $(pwd). Run this from the stack directory's scripts/."
# Compose run from the stack dir reads its .env (COMPOSE_FILE, the core shape
# included), so this is the same project the installer brought up.
COMPOSE=(docker compose)
WIZARD=(pnpm -C server/web exec tsx scripts/onboard.ts)

if [[ $HELP -eq 1 ]]; then
  usage
  printf '\n'
  "${COMPOSE[@]}" exec -T web "${WIZARD[@]}" --help 2>/dev/null || true
  exit 0
fi

"${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx web \
  || die "The web service isn't running. Bring the stack up first: docker compose up -d --wait"

if [[ -n "$PASS_FILE" || -n "$KEY_FILE" ]]; then
  if [[ -n "$PASS_FILE" && ! -r "$PASS_FILE" ]]; then die "Can't read the password file: $PASS_FILE"; fi
  if [[ -n "$KEY_FILE" && ! -r "$KEY_FILE" ]]; then die "Can't read the key file: $KEY_FILE"; fi
  # printf is a shell builtin: the values never appear in any process's argv.
  {
    if [[ -n "$PASS_FILE" ]]; then printf 'password=%s\n' "$(head -n 1 "$PASS_FILE")"; fi
    if [[ -n "$KEY_FILE" ]]; then printf 'openrouter_key=%s\n' "$(head -n 1 "$KEY_FILE")"; fi
  } | "${COMPOSE[@]}" exec -T web "${WIZARD[@]}" --secrets-stdin ${ARGS[@]+"${ARGS[@]}"}
elif [[ -t 0 && -t 1 ]]; then
  exec "${COMPOSE[@]}" exec -it web "${WIZARD[@]}" ${ARGS[@]+"${ARGS[@]}"}
else
  # No terminal (a pipe, a CI job): the wizard needs --yes, and says so.
  exec "${COMPOSE[@]}" exec -T web "${WIZARD[@]}" ${ARGS[@]+"${ARGS[@]}"}
fi
