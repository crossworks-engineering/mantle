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
#     database (off, warn or on; "not set" until A2a and A3a add them);
#   - the rights counts (plan v3, rule 10), each a number counted on the
#     box: role drift (mantle_role_drift(): enabled logins, former clients
#     left out, whose role disagrees with Admin; n/a on a box that has no
#     such function yet, never a guessed 0), brains without a live Admin
#     workspace, live Admin workspaces with no assistant and no assistant
#     removal event, the SQL functions writing the four workspace tables
#     (the live catalog; scripts/arch-scoreboard.pins.json
#     workspaceTableWriterFns is the repo's), and whether
#     MANTLE_DB_RUNTIME_ROLE is on (1 or 0, as the app reads it: from
#     mantle_web's environment, or from the stack's .env when that
#     container is not there; n/a with neither, or an unreadable .env);
#   - the fail-open counts (plan v3.2 S4a; packages/db/src/fail-open.ts):
#     the distinct site and file pairs of the miss rows checked
#     'fail-open:<site>' in the last 24 hours, or since the last roll began
#     (the updater's started_at) when that is later but never from later
#     than an hour ago, in all and per site. Every process writes its row
#     again each hour it still hits (fail-open.ts), so a process that has
#     not restarted still shows. "Brains without an Admin workspace" above is
#     also the count of mantle_login_area's yes with no Admin workspace and
#     of areasOf's "migration skipped" path (server/web/lib/workspaces.ts):
#     a brain reaches either only with no Admin workspace;
#   - the narrow system role's counts (plan v3.2 S7a, report only): the
#     distinct check, actor and table rows checked narrow-content-write,
#     narrow-cascade-delete (migration 0312) and narrow-denied, in the
#     fail-open rows' window;
#   - whether the stack's .env has a MANTLE_DB_RUNTIME_ROLE line at all (1
#     or 0; the updater and roll.sh write one, S4a), n/a with no readable
#     .env.
#
# Read only: docker logs, docker inspect, SELECTs and one line of .env.
# Name the box explicitly; there is no default and no fleet loop.
#
# Usage:
#   scripts/arch-scoreboard-box.sh [--since <duration>] [--stack <dir>] <ssh-alias>
#
#   --stack  the box's stack dir (default: the updater's MANTLE_STACK_DIR)
#   ARCH_BOX_PG=<container>  the database container (default mantle_pg; a
#            throwaway database for a dry run)
#   ARCH_BOX_WEB=<container> the app container whose environment is read
#            (default mantle_web; a throwaway container for a dry run)
set -euo pipefail

since=""
stack=""
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --since) since="${2:?--since needs a duration, e.g. 24h}"; shift 2 ;;
    --stack) stack="${2:?--stack needs a directory}"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
host="${1:?usage: scripts/arch-scoreboard-box.sh [--since <duration>] [--stack <dir>] <ssh-alias>}"
pg="${ARCH_BOX_PG:-mantle_pg}"
web="${ARCH_BOX_WEB:-mantle_web}"
case "$pg" in *[!A-Za-z0-9_.-]*) echo "not a container name: $pg" >&2; exit 2 ;; esac
case "$web" in *[!A-Za-z0-9_.-]*) echo "not a container name: $web" >&2; exit 2 ;; esac
case "$stack" in *[!A-Za-z0-9_./-]*) echo "not a plain path: $stack" >&2; exit 2 ;; esac

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
ssh -n "$host" "docker exec $pg psql -U postgres -d postgres -tAc \"select
  'actor_check=' || coalesce(nullif(current_setting('mantle.actor_check', true), ''), 'not set'),
  'edit_check=' || coalesce(nullif(current_setting('mantle.edit_check', true), ''), 'not set')\""

echo "== rights counts on $host"
# Every query answers one integer; the role drift query runs only where its
# function exists, so a box before it says n/a rather than 0.
# shellcheck disable=SC2029
ssh "$host" bash -s -- "'$pg'" "'$stack'" "'$web'" <<'REMOTE'
pg="$1"
stack="$2"
web="$3"
q() { docker exec -i "$pg" psql -U postgres -d postgres -tAq -v ON_ERROR_STOP=1 2>/dev/null; }
num() { case "$1" in '' | *[!0-9]*) echo "?" ;; *) echo "$1" ;; esac; }
drift=n/a
has=$(echo "select to_regprocedure('public.mantle_role_drift()') is not null;" | q || true)
if [ "$has" = t ]; then
  drift=$(num "$(echo 'select public.mantle_role_drift()::bigint;' | q || true)")
fi
no_admin=$(num "$(q <<'SQL' || true
select count(*) from auth.users o
 where o.is_owner
   and not exists (select 1 from public.workspaces w
                    where w.owner_id = o.id and w.is_admin and w.archived_at is null);
SQL
)")
no_assistant=$(num "$(q <<'SQL' || true
select count(*) from public.workspaces w
 where w.is_admin and w.archived_at is null
   and not exists (select 1 from public.workspace_resources r
                    where r.workspace_id = w.id and r.type = 'assistant')
   and not exists (select 1 from public.workspace_events e
                    where e.workspace_id = w.id and e.action = 'resource.remove'
                      and e.subject ->> 'kind' = 'assistant');
SQL
)")
writers=$(num "$(q <<'SQL' || true
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prosrc ~* '\m(insert\s+into|update|delete\s+from|merge\s+into|truncate(\s+table)?)\s+(only\s+)?("?public"?\s*\.\s*)?"?(workspaces|workspace_users|workspace_events|workspace_resources)"?($|[^a-z0-9_"])';
SQL
)")
# The fail-open miss rows (S4a): the last 24 hours, or since the last roll
# began when that is later, but never from later than an hour ago: any
# status.json write moves started_at (a client-only roll, a refused one, a
# bad tag, the pull phase), and none of those restarts a server, so a floor
# at most an hour old keeps every process's hourly row in the window (an
# error reads as a false non-zero, never a false 0). Not since mantle_web
# started: a web-only restart would hide the rows the api, worker and MCP
# processes wrote.
started=$(docker exec mantle_updater cat /signal/status.json 2>/dev/null |
  sed -n 's/.*"started_at":"\([^"]*\)".*/\1/p' | head -1 || true)
case "$started" in *[!0-9TZ:.+-]* | '') started="" ;; esac
fail_open=$(q <<SQL || true
select count(*) || ' ' || count(*) filter (where check_name = 'fail-open:scope-holds-admin')
    || ' ' || count(*) filter (where check_name = 'fail-open:scope-has-area')
    || ' ' || count(*) filter (where check_name = 'fail-open:typed-write')
    || ' ' || count(*) filter (where check_name = 'fail-open:raw-write')
    || ' ' || count(*) filter (where check_name = 'fail-open:turn-exit')
    || ' ' || count(*) filter (where check_name = 'fail-open:system-db')
  from (select distinct check_name, detail from public.actor_check_misses
         where check_name like 'fail-open:%'
           and at >= greatest(now() - interval '24 hours',
                              least(coalesce(nullif('$started', '')::timestamptz, '-infinity'),
                                    now() - interval '1 hour'))) m;
SQL
)
# The narrow system role's counts (plan v3.2 S7a; report only): the
# distinct check, actor and table rows of its miss rows in the same window
# as the fail-open rows. narrow-content-write and narrow-cascade-delete:
# migration 0312's count of a content write, or a delete that cascades into
# content, by a narrow reason off the narrow role (what the role would
# refuse once it is on, S7b); narrow-denied: a right the role does not hold,
# met on the narrow route. Numbers only.
narrow=$(q <<SQL || true
select count(*) filter (where check_name = 'narrow-content-write')
    || ' ' || count(*) filter (where check_name = 'narrow-cascade-delete')
    || ' ' || count(*) filter (where check_name = 'narrow-denied')
  from (select distinct check_name, actor, detail from public.actor_check_misses
         where check_name in ('narrow-content-write', 'narrow-cascade-delete', 'narrow-denied')
           and at >= greatest(now() - interval '24 hours',
                              least(coalesce(nullif('$started', '')::timestamptz, '-infinity'),
                                    now() - interval '1 hour'))) m;
SQL
)
# Whether the stack's .env has the runtime role's line at all (S4a: the
# updater and roll.sh write one when it has none).
env_stack="$stack"
if [ -z "$env_stack" ]; then
  env_stack=$(docker inspect --type container mantle_updater --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
    sed -n 's/^MANTLE_STACK_DIR=//p' | head -1)
fi
env_line=n/a
if [ -n "$env_stack" ] && [ -r "$env_stack/.env" ]; then
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?MANTLE_DB_RUNTIME_ROLE[[:space:]]*=' "$env_stack/.env" 2>/dev/null; then
    env_line=1
  else
    env_line=0
  fi
fi
# MANTLE_DB_RUNTIME_ROLE as the app reads it (packages/config/src/parse.ts
# parseFlag): the value in the app container's environment, which is what
# the app sees; the stack's .env only when that container is not there.
# 1 when on (1, true, yes, on; any case, the ends trimmed), 0 when unset,
# empty, 0 or anything else. Only the number leaves the box.
names_role=n/a
have=0
raw=""
if env_dump=$(docker inspect --type container "$web" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null); then
  have=1
  raw=$(printf '%s\n' "$env_dump" | sed -n 's/^MANTLE_DB_RUNTIME_ROLE=//p' | tail -n 1)
else
  if [ -z "$stack" ]; then
    stack=$(docker inspect --type container mantle_updater --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
      sed -n 's/^MANTLE_STACK_DIR=//p' | head -1)
  fi
  if [ -n "$stack" ] && [ -r "$stack/.env" ]; then
    have=1
    # As compose reads a .env line: an `export ` before the name is
    # dropped; the last line wins; a quoted value is what the quotes hold;
    # an unquoted one ends at a comment (a # at its start or after a space).
    raw=$(sed -n 's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}MANTLE_DB_RUNTIME_ROLE[[:space:]]*=//p' "$stack/.env" 2>/dev/null | tail -n 1 | tr -d '\r')
    raw=$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//')
    case "$raw" in
      \"*) raw=$(printf '%s' "$raw" | sed -n 's/^"\([^"]*\)".*$/\1/p') ;;
      \'*) raw=$(printf '%s' "$raw" | sed -n "s/^'\([^']*\)'.*\$/\1/p") ;;
      *) raw=$(printf '%s' "$raw" | sed -e 's/^#.*$//' -e 's/[[:space:]]#.*$//') ;;
    esac
  fi
fi
if [ "$have" = 1 ]; then
  v=$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')
  case "$v" in 1 | true | yes | on) names_role=1 ;; *) names_role=0 ;; esac
fi
printf '  %-34s %s\n' role_drift "$drift"
printf '  %-34s %s\n' brains_without_admin_workspace "$no_admin"
printf '  %-34s %s\n' admin_workspaces_without_assistant "$no_assistant"
printf '  %-34s %s\n' workspace_table_writer_fns "$writers"
printf '  %-34s %s\n' env_names_runtime_role "$names_role"
printf '  %-34s %s\n' env_has_runtime_role_line "$env_line"
set -- $fail_open
for site in all scope-holds-admin scope-has-area typed-write raw-write turn-exit system-db; do
  printf '  %-34s %s\n' "fail_open_misses:$site" "$(num "${1:-}")"
  shift || true
done
set -- $narrow
for check in content-write cascade-delete denied; do
  printf '  %-34s %s\n' "narrow_misses:$check" "$(num "${1:-}")"
  shift || true
done
REMOTE
