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
#     back over ssh: never a path, an id or a log line;
#   - the check settings: mantle.actor_check and mantle.edit_check on the
#     database (off, warn or on; "not set" on a box without them);
#   - the rights counts, each a number counted on the
#     box: role drift (mantle_role_drift(): enabled logins whose role
#     disagrees with Admin, former clients left out before migration 0330
#     and counted from it; n/a on a box that has no
#     such function yet, never a guessed 0), the same over ALL logins
#     (disabled ones and former clients too: a login whose role
#     says admin without a user row in the live Admin workspace, or the
#     other way; asked of the tables directly, so a box before migration
#     0330 answers it too; n/a where the tables are not there yet),
#     brains without a live Admin
#     workspace, live Admin workspaces with no assistant and no assistant
#     removal event, the SQL functions writing the four workspace tables
#     (the live catalog; scripts/arch-scoreboard.pins.json
#     workspaceTableWriterFns is the repo's), and whether
#     MANTLE_DB_RUNTIME_ROLE is on (1 or 0, as the app reads it: from
#     mantle_web's environment, or from the stack's .env when that
#     container is not there; n/a with neither, or an unreadable .env);
#   - the fail-open branches: gone (each throws, or
#     answers no, docs/fail-open.md), so the line says "gone", never a
#     count;
#   - the narrow system role's count: the distinct actor and right rows
#     checked narrow-denied (a right the role lacks, met on the narrow
#     route) since the release's epoch (the latest narrow-epoch row:
#     migrate writes one per version; all time on a box with none), and
#     that epoch's version and time; the grant hold's trigger count (8);
#     the same count over the epoch before; and real use since the epoch,
#     counts only (member chat turns, audited actions, active logins: a 0
#     with no traffic proves nothing);
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
drift_all=n/a
has=$(echo "select to_regclass('public.workspace_users') is not null;" | q || true)
if [ "$has" = t ]; then
  drift_all=$(num "$(q <<'SQL' || true
select count(*) from auth.users l
 where coalesce(l.role = 'admin', false) <> exists (
         select 1 from public.workspaces w
           join public.workspace_users u on u.workspace_id = w.id and u.login_id = l.id
           join auth.users o on o.id = w.owner_id and o.is_owner
          where w.is_admin and w.archived_at is null);
SQL
)")
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
# The narrow system role's count: narrow-denied, a right the role does not
# hold, met on the narrow route, or a text the route's check refused
# (text:<what>), as distinct actor and right rows. Since the release's
# epoch, not the last 24 hours: every row since the latest narrow-epoch row
# counts (migrate writes one per release, its detail the version; an
# operator may write one by hand to start again, docs/runtime-role.md "The
# narrow-denied count"). A box with no epoch row reads all time. The
# maintenance reaper keeps the narrow rows, the epoch rows too. The epoch
# row itself is never counted.
narrow=$(q <<SQL || true
select count(*)
  from (select distinct actor, detail from public.actor_check_misses
         where check_name = 'narrow-denied'
           and at >= coalesce((select max(at) from public.actor_check_misses
                                where check_name = 'narrow-epoch'), '-infinity')) m;
SQL
)
# The same count over the epoch before (from the second latest epoch row
# to the latest): a release that reset the count shows what the one
# before it saw (0 with fewer than two epochs).
narrow_prev=$(q <<SQL || true
with e as (select at from public.actor_check_misses where check_name = 'narrow-epoch'
            order by at desc, id desc limit 2),
     w as (select min(at) as lo, max(at) as hi, count(*) as n from e)
select count(*)
  from (select distinct actor, detail from public.actor_check_misses, w
         where check_name = 'narrow-denied'
           and w.n = 2 and at >= w.lo and at < w.hi) m;
SQL
)
# The grant hold's triggers (mantle_narrow_token_hold_trg, enabled: origin
# or always, a replica only one never fires on a box): 5
# from 0327 (access_keys, oauth_access_tokens, mobile_tokens,
# oauth_auth_codes, oauth_clients) and 3 from 0328 (pairing_codes,
# push_subscriptions, mantle_peers): 8 from 0328 on.
narrow_holds=$(q <<'SQL' || true
select count(*) from pg_trigger
 where not tgisinternal and tgname = 'mantle_narrow_token_hold_trg' and tgenabled in ('O', 'A');
SQL
)
# The epoch the narrow count starts from: its version and time (UTC), or
# none. A hand-written epoch's detail is the operator's reason, free text,
# so only a plain version is printed and anything else reads "reset".
narrow_epoch=$(q <<SQL || true
select case when detail ~ '^[0-9]+[.][0-9]+[.][0-9]+' and detail !~ '[^0-9A-Za-z.-]'
            then detail else 'reset' end
       || ' ' || to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  from public.actor_check_misses
 where check_name = 'narrow-epoch'
 order by at desc, id desc
 limit 1;
SQL
)
# Real use since the narrow epoch (counts only: a 0 narrow-denied with no
# traffic proves nothing):
# member chat turns (the member turn ledger; rows older than its own keep
# window are gone), audited actions (every audit_log row: the areas' and
# the logins' recorded actions, not only the Admin areas'), and active logins (distinct logins that sent a chat message or
# made an audited action). All time on a box with no epoch.
traffic=$(q <<'SQL' || true
with e as (select coalesce((select max(at) from public.actor_check_misses
                             where check_name = 'narrow-epoch'), '-infinity') as at)
select (select count(*) from public.member_turn_ledger l, e where l.created_at >= e.at)
    || ' ' || (select count(*) from public.audit_log a, e where a.created_at >= e.at)
    || ' ' || (select count(distinct x) from (
                 select m.login_id as x from public.assistant_messages m, e
                  where m.created_at >= e.at and m.direction = 'inbound' and m.login_id is not null
                 union
                 select a.actor_id from public.audit_log a, e
                  where a.created_at >= e.at and a.actor_id is not null) u);
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
printf '  %-34s %s\n' role_drift_all_logins "$drift_all"
printf '  %-34s %s\n' brains_without_admin_workspace "$no_admin"
# The precondition for the role to follow Admin membership: the three
# above all 0. Anything else, n/a or ? included, is a no.
s8b_ready=no
[ "$drift" = 0 ] && [ "$drift_all" = 0 ] && [ "$no_admin" = 0 ] && s8b_ready=yes
printf '  %-34s %s\n' s8b_precondition_met "$s8b_ready"
printf '  %-34s %s\n' admin_workspaces_without_assistant "$no_assistant"
printf '  %-34s %s\n' workspace_table_writer_fns "$writers"
printf '  %-34s %s\n' env_names_runtime_role "$names_role"
printf '  %-34s %s\n' env_has_runtime_role_line "$env_line"
printf '  %-34s %s\n' fail_open_branches gone
case "$narrow_epoch" in
  '') narrow_epoch=none ;;
  *[!0-9A-Za-z.:\ -]*) narrow_epoch='?' ;;
esac
printf '  %-34s %s\n' narrow_misses_since_epoch "$narrow_epoch"
printf '  %-34s %s\n' narrow_hold_triggers "$(num "$narrow_holds")"
printf '  %-34s %s\n' narrow_misses:denied "$(num "$narrow")"
set -- $traffic
for what in member-turns audited-actions active-logins; do
  printf '  %-34s %s\n' "narrow_traffic_since_epoch:$what" "$(num "${1:-}")"
  shift || true
done
printf '  %-34s %s\n' narrow_prev_epoch:denied "$(num "$narrow_prev")"
REMOTE
