#!/usr/bin/env bash
# runs-on: mac. A dev or operator machine, the Mac included: keep it bash 3.2 and BSD-tool safe.
#
# arch-scoreboard-box.sh: the scoreboard numbers of ONE box (workspaces arch
# plan v2, section 3; A0), read over ssh. Not part of pnpm verify, which
# counts the repo only (scripts/arch-scoreboard.ts) and never reaches a box.
#
#   - 410 hits: lines `[gone] 410 <path>` in mantle_web's log (lib/gone.ts),
#     by path, since the container started (or --since, a docker duration);
#   - the check settings: mantle.actor_check and mantle.edit_check on the
#     database (off, warn or on; "not set" until A2a and A3a add them).
#
# Read only: docker logs and one SELECT. Name the box explicitly; there is
# no default and no fleet loop.
#
# Usage:
#   scripts/arch-scoreboard-box.sh [--since <duration>] <ssh-alias>
set -euo pipefail

since=""
if [[ "${1:-}" == "--since" ]]; then
  since="${2:?--since needs a duration, e.g. 24h}"
  shift 2
fi
host="${1:?usage: scripts/arch-scoreboard-box.sh [--since <duration>] <ssh-alias>}"

logs_args=(logs)
if [[ -n "$since" ]]; then logs_args+=(--since "$since"); fi
logs_args+=(mantle_web)

echo "== 410 hits on $host (${since:-since start})"
# shellcheck disable=SC2029
ssh -n "$host" "docker ${logs_args[*]} 2>&1" |
  grep -o '\[gone\] 410 [^ ]*' |
  awk '{print $3}' | sort | uniq -c | sort -rn || echo "  none"

echo "== check settings on $host"
# shellcheck disable=SC2029
ssh -n "$host" "docker exec mantle_pg psql -U postgres -d postgres -tAc \"select
  'actor_check=' || coalesce(nullif(current_setting('mantle.actor_check', true), ''), 'not set'),
  'edit_check=' || coalesce(nullif(current_setting('mantle.edit_check', true), ''), 'not set')\""
