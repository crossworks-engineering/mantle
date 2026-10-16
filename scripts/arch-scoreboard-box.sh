#!/usr/bin/env bash
# runs-on: mac. A dev or operator machine, the Mac included: keep it bash 3.2 and BSD-tool safe.
#
# arch-scoreboard-box.sh: the scoreboard numbers of ONE box (workspaces arch
# plan v2, section 3; A0), read over ssh. Not part of pnpm verify, which
# counts the repo only (scripts/arch-scoreboard.ts) and never reaches a box.
#
#   - 410 hits: lines `[gone] 410 <path>` in mantle_web's log (lib/gone.ts),
#     since the container started (one release: a roll restarts it), or
#     --since (a docker duration). Counted ON THE BOX, by stub family (the
#     first segment after /api/ of the retired routes), so only numbers come
#     back over ssh: never a path, an id or a log line (arch A7);
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

# The stub families, in the order the box prints its counts; the last
# count is every other hit (no request path, or a family not listed).
FAMILIES="access admin app-nav apps auth client mcp-logins member team-admin"

echo "== 410 hits on $host (${since:-since start}), by stub family"
# shellcheck disable=SC2029
counts=$(ssh "$host" bash -s -- "'$since'" "'$FAMILIES'" <<'REMOTE'
since="$1"
families="$2"
args=(logs)
if [ -n "$since" ]; then args+=(--since "$since"); fi
args+=(mantle_web)
docker "${args[@]}" 2>&1 | awk -v fams="$families" '
  BEGIN { n = split(fams, f, " ") }
  match($0, /\[gone\] 410 [^ ]*/) {
    p = substr($0, RSTART + 11, RLENGTH - 11); k = 0
    if (substr(p, 1, 5) == "/api/") {
      s = substr(p, 6); sub(/[\/?].*/, "", s)
      for (i = 1; i <= n; i++) if (s == f[i]) k = i
    }
    c[k]++
  }
  END { for (i = 1; i <= n; i++) printf "%d ", c[i] + 0; printf "%d\n", c[0] + 0 }'
REMOTE
)
set -- $counts
for fam in $FAMILIES other; do
  printf '  %-12s %s\n' "$fam" "${1:-?}"
  shift || true
done

echo "== check settings on $host"
# shellcheck disable=SC2029
ssh -n "$host" "docker exec mantle_pg psql -U postgres -d postgres -tAc \"select
  'actor_check=' || coalesce(nullif(current_setting('mantle.actor_check', true), ''), 'not set'),
  'edit_check=' || coalesce(nullif(current_setting('mantle.edit_check', true), ''), 'not set')\""
