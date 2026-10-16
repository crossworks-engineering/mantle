#!/usr/bin/env bash
# runs-on: mac. A dev or operator machine, the Mac included: keep it bash 3.2 and BSD-tool safe.
#
# roll.sh: roll ONE box to a release tag through its own updater, with the
# guards the fleet rules ask for, and stop loudly the moment one fails.
#
#   1. preflight: the updater is idle, no request is pending
#   2. count apps, sandboxes (Postgres) and app-db files (mantle_web) BEFORE;
#      refuse a roll to the workspaces switch (v0.239.90 on) on a box with
#      clients that is not on workspaces yet (2a, plan 21.9), a box that
#      still has a page-built (v1) Recall map (2b), and one
#      where the roll would open connector write tools to members, clients or
#      apps (2c, team apps Phase 2) unless --ack-connector-writes, or
#      breaks a live app's run-time schema SQL for members, clients or
#      contacts (2c, rows only below admin) unless --ack-app-ddl; refuse a
#      roll to a release that ships the checks' floor (the pre-check
#      removal, *_check_mode_floor.sql in the target's tree; a target this
#      checkout cannot tell counts as one) on a box whose actor or edit
#      check is not on, unless its .env says MANTLE_CHECK_FLOOR=keep (2d)
#   3. backup: scripts/db-dump.sh on the box, strict, its OWN exit status
#      (no pipe in front of it). Skipped only when the box's updater takes
#      its own strict pre-roll backup (see pre_roll_backup in
#      infra/updater/updater.sh), which it then must have done.
#   4. request: request.json holding only {"target": <tag>}, written into the
#      updater's signal dir by a throwaway alpine container (the dir is
#      root-owned on the host), exactly as the in-app Update button would
#   5. wait for a NEW started_at with this target and a finished_at, ok:true
#   6. wait for mantle_web healthy; if it never is, a loud banner and the
#      last 20 lines of its log, every line, with secret values masked. No
#      automatic rollback: the operator decides.
#   7. count again: ANY drop in apps, sandboxes or app-db files stops with a
#      loud error (mini sandbox apps are never to be lost in a roll)
#   8. print /api/version
#
# Usage:
#   scripts/roll.sh [--dry-run] [--ack-connector-writes] [--ack-app-ddl] [--app-ddl-ids] <box-label> <tag>
#   scripts/roll.sh [--dry-run] [--ack-connector-writes] [--ack-app-ddl] [--app-ddl-ids] --ssh <alias> [--stack <dir>] [--url <origin>] <tag>
# --app-ddl-ids: print the ids (only) of the live apps below admin whose
# run-time SQL would break after the roll, then stop (read only).
#
# <box-label> is looked up in .mantle-fleet.json at the repo root (untracked,
# see .mantle-fleet.example.json; MANTLE_FLEET_FILE points elsewhere), the same
# file `pnpm status` reads: `ssh` (required here), `url` (for /api/version) and
# optional `stack`. Hostnames never live in this script or anywhere tracked.
# Without `stack` the stack dir is read from the box's updater container
# (MANTLE_STACK_DIR), so a box whose stack is not in ~/mantle is still right.
#
# --dry-run runs steps 1 and 2 only: read-only, no backup, no request.
#
# ROLL_ALLOW_V1_RECALL=1 lets step 2b pass a page-built Recall map.
# ROLL_RELEASE_GIT: the git checkout step 2d reads the target's tag from
# (default: the one this script is in).
#
# Exit codes: 0 rolled and verified, 1 a step failed (nothing requested when it
# failed before step 4), 2 usage, 3 COUNTS DROPPED after the roll.
#
# Env: ROLL_POLL_SECS (15), ROLL_TIMEOUT_SECS (2400), ROLL_HEALTH_TIMEOUT_SECS (900).

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
POLL=${ROLL_POLL_SECS:-15}
TIMEOUT=${ROLL_TIMEOUT_SECS:-2400}
HEALTH_TIMEOUT=${ROLL_HEALTH_TIMEOUT_SECS:-900}

die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
usage() { sed -n '/^# Usage:/,/^# --dry-run/p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

DRY=""; ACK_CONNECTOR_WRITES=""; ACK_APP_DDL=""; APP_DDL_IDS=""; SSH_ALIAS=""; STACK=""; URL=""; LABEL=""; TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --ack-connector-writes) ACK_CONNECTOR_WRITES=1; shift ;;
    --ack-app-ddl) ACK_APP_DDL=1; shift ;;
    --app-ddl-ids) APP_DDL_IDS=1; shift ;;
    --ssh) SSH_ALIAS=${2:-}; shift 2 ;;
    --stack) STACK=${2:-}; shift 2 ;;
    --url) URL=${2:-}; shift 2 ;;
    -h | --help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *)
      if [ -z "$SSH_ALIAS" ] && [ -z "$LABEL" ]; then LABEL=$1; else TAG=$1; fi
      shift ;;
  esac
done
[ -n "$TAG" ] || usage
# The updater's own whitelist: a tag reaches a docker command.
case "$TAG" in *[!A-Za-z0-9._-]*) echo "invalid tag: $TAG" >&2; exit 2 ;; esac

# ── the box ──────────────────────────────────────────────────────────────────
if [ -n "$LABEL" ]; then
  FLEET=${MANTLE_FLEET_FILE:-$ROOT/.mantle-fleet.json}
  [ -f "$FLEET" ] || die "no $FLEET: pass --ssh <alias> or add the box there (see .mantle-fleet.example.json)"
  command -v node >/dev/null || die "node is needed to read $FLEET"
  # shellcheck disable=SC2016  # JavaScript, not shell: nothing to expand
  BOX=$(node -e '
    const [file, label] = process.argv.slice(1);
    const raw = JSON.parse(require("fs").readFileSync(file, "utf8"));
    const boxes = Array.isArray(raw) ? raw : raw.boxes ?? [];
    const b = boxes.find((x) => x && x.label === label);
    if (!b) { console.error(`no box labelled "${label}" in ${file}`); process.exit(1); }
    console.log([b.ssh ?? "", b.stack ?? "", b.url ?? ""].join("\x1f"));
  ' "$FLEET" "$LABEL") || die "box lookup failed"
  # Unit separator, not a tab: read merges runs of a whitespace IFS, so an
  # empty "stack" between two tabs would shift the url into it.
  IFS=$'\x1f' read -r cfg_ssh cfg_stack cfg_url <<< "$BOX" || true
  SSH_ALIAS=${SSH_ALIAS:-$cfg_ssh}; STACK=${STACK:-$cfg_stack}; URL=${URL:-$cfg_url}
  [ -n "$SSH_ALIAS" ] || die "box \"$LABEL\" has no \"ssh\" in $FLEET"
fi
[ -n "$SSH_ALIAS" ] || usage

rsh() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_ALIAS" "$@"; }

# Stack dir and signal dir, from the updater container itself (the only
# authoritative answer; a directory that merely looks right is not evidence).
UPD_JSON=$(rsh docker inspect mantle_updater) || die "cannot inspect mantle_updater on $SSH_ALIAS (no updater on this box?)"
# shellcheck disable=SC2016  # JavaScript, not shell: nothing to expand
read -r UPD_STACK SIGDIR < <(node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8"))[0] ?? {};
  const env = (j.Config?.Env ?? []).find((e) => e.startsWith("MANTLE_STACK_DIR=")) ?? "";
  const sig = (j.Mounts ?? []).find((m) => m.Destination === "/signal")?.Source ?? "";
  console.log(`${env.slice("MANTLE_STACK_DIR=".length) || "-"} ${sig || "-"}`);
' <<< "$UPD_JSON") || die "cannot read the updater's config"
[ "$UPD_STACK" = - ] && UPD_STACK=""
[ "$SIGDIR" = - ] && die "the updater on $SSH_ALIAS has no /signal mount"
STACK=${STACK:-$UPD_STACK}
[ -n "$STACK" ] || die "no stack dir: the updater has no MANTLE_STACK_DIR; pass --stack"
# Both reach a remote shell; keep them to plain path characters.
for p in "$STACK" "$SIGDIR"; do
  case "$p" in /*) ;; *) die "not an absolute path: $p" ;; esac
  case "$p" in *[!A-Za-z0-9._/-]*) die "unexpected characters in path: $p" ;; esac
done

field() { sed -n "s/.*\"$1\":\"\\{0,1\\}\\([^\",}]*\\).*/\\1/p" | head -1; }
status_json() { rsh docker exec mantle_updater cat /signal/status.json 2>/dev/null || true; }

# counts: "<apps> <sandboxes> <app-db files>", each a whole number, or fail.
counts() {
  local out
  out=$(rsh 'sh -s' <<'EOF'
set -e
a=$(docker exec mantle_pg psql -U postgres -d postgres -Atc 'select count(*) from apps')
s=$(docker exec mantle_pg psql -U postgres -d postgres -Atc 'select count(*) from sandboxes')
f=$(docker exec mantle_web sh -c 'd="${APP_DB_DIR:-/data/app-dbs}"; if [ -d "$d" ]; then find "$d" -type f -name "*.sqlite" | wc -l; else echo 0; fi')
echo "$a $s $f"
EOF
  ) || return 1
  out=$(printf '%s' "$out" | tr -d '\r' | tr -s ' ')
  case "$out" in *[!0-9\ ]* | '') return 1 ;; esac
  [ "$(printf '%s\n' "$out" | wc -w | tr -d ' ')" = 3 ] || return 1
  printf '%s' "$out"
}

echo "===== $SSH_ALIAS → $TAG   (stack $STACK)"

# ── 1. preflight ─────────────────────────────────────────────────────────────
S0=$(status_json)
[ -n "$S0" ] || die "cannot read the updater status on $SSH_ALIAS"
echo "status before: $S0"
PHASE0=$(printf '%s' "$S0" | field phase)
case "$PHASE0" in
  pulling | rolling) die "an update is already running (phase $PHASE0); wait for it" ;;
  unconfigured) die "the updater is not configured: $(printf '%s' "$S0" | field error)" ;;
esac
if rsh "test -e '$SIGDIR/request.json'" 2>/dev/null; then
  die "a request.json is already waiting in $SIGDIR; not stacking a second one"
fi
OLD_STARTED=$(printf '%s' "$S0" | field started_at)
rsh "df -h '$STACK' | tail -1" || true

# ── 2. counts before ─────────────────────────────────────────────────────────
C0=$(counts) || die "could not count apps / sandboxes / app-db files (is the stack up?)"
read -r APPS0 SBX0 FILES0 <<< "$C0"
echo "before: apps=$APPS0 sandboxes=$SBX0 app-db files=$FILES0"

# ── 2a. workspaces: a box with clients is set up by hand first ─────────────
# From the workspaces switch (W5b2, migration 0261) the grants alone decide
# who reads what. A brain that is NOT on workspaces because it has clients
# (an anchor, no Admin workspace, and client logins or client-level items;
# plan 21.9) is left on its levels by 0261, but the code of that release
# reads no level: its members, clients and assistants would read nothing.
# So a roll to v$WS_SWITCH_FLOOR or later (`latest` and any tag that is not
# a release version count as later) is refused on such a box until its
# workspaces are set up by hand. "No Admin workspace" is the release's own
# test (mantle_ws_skip_reason: no workspace with bridge_key 'admin'). Plain
# SQL on the box's CURRENT schema, from v0.239.35 on (no workspaces table
# there, no mantle_ws_skip_reason): SELECT only, digits only. The updater
# runs the same SQL (infra/updater/updater.sh, ws_switch_refusal); a test
# pins the two copies equal (packages/db/src/ws-switch-preflight.db.test.ts).
# WS_SWITCH_FLOOR is a lower bound for the release that carries the switch
# (the next one after v0.239.89): a release between it and the real one is
# refused too on such a box, which only stops a roll that was safe.
WS_SWITCH_FLOOR=0.239.90
# 0 when <tag> (the second argument) is at or past release <floor> (the
# first), or not a release version.
tag_at_or_past() {
  local f=$1 v=${2#v} x y i
  case "$v" in *.*.*.* | *[!0-9.]* | .* | *. | *..*) return 0 ;; *.*.*) ;; *) return 0 ;; esac
  for i in 1 2 3; do
    x=${v%%.*}; y=${f%%.*}
    [ "$x" -lt "$y" ] && return 1
    [ "$x" -gt "$y" ] && return 0
    v=${v#*.}; f=${f#*.}
  done
  return 0
}
# 0 when <tag> is at or past the switch release, or not a release version.
crosses_ws_switch() { tag_at_or_past "$WS_SWITCH_FLOOR" "$1"; }
ws_switch_sql() {
  cat <<'WS_SWITCH_SQL'
with brain as (
  select u.id from auth.users u where u.is_owner order by u.created_at limit 1
), s as (
  select
    (select count(*) from brain) as anchored,
    case when to_regclass('public.workspaces') is null then 0
         else (xpath('/row/n/text()', query_to_xml(format(
           'select count(*) as n from public.workspaces w where w.owner_id = %L and to_jsonb(w)->>%L = %L',
           (select b.id from brain b), 'bridge_key', 'admin'), false, true, '')))[1]::text::bigint
    end as admin_ws,
    (select count(*) from auth.users u where to_jsonb(u)->>'role' = 'client') as clients,
    (select count(*) from public.nodes n
      where n.owner_id = (select b.id from brain b)
        and (n.audience::text = 'client' or n.inherited_level::text = 'client'
             or n.embedded_level::text = 'client')) as client_items
)
select case when anchored = 1 and admin_ws = 0 and (clients > 0 or client_items > 0)
            then 1 else 0 end,
       clients, client_items
  from s;
WS_SWITCH_SQL
}
if crosses_ws_switch "$TAG"; then
  WS=$(ws_switch_sql | rsh "docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At -F ' '") ||
    die "could not check whether this box is on workspaces"
  WS=$(printf '%s' "$WS" | tr -d '\r' | tr -s ' ')
  case "$WS" in *[!0-9\ ]* | '') die "unexpected workspaces check: $WS" ;; esac
  read -r WS_REFUSE WS_CLIENTS WS_CLIENT_ITEMS <<< "$WS"
  if [ "$WS_REFUSE" = 1 ]; then
    die "this box has clients and is not on workspaces yet ($WS_CLIENTS client login(s), $WS_CLIENT_ITEMS client-level item(s)). From v$WS_SWITCH_FLOOR the grants alone decide reads, so its members, clients and assistants would read nothing after this roll. Set up workspaces by hand first (plan 21.9), then roll."
  fi
  echo "workspaces: nothing stops the switch here (client logins: $WS_CLIENTS, client-level items: $WS_CLIENT_ITEMS)"
else
  echo "workspaces: $TAG is before the switch (v$WS_SWITCH_FLOOR); not checked"
fi

# ── 2b. Recall: no page-built (v1) map may be left ──────────────────────────
# From Recall R5 (migration 0209) a page-built map is not served, and 0209
# deletes it. Its slug must first be retired by hand on a release that still
# has the v1 code (docs/update-prod.md, "Rolling to the Recall R5 release"),
# or every agent and skill that remembers it loses it silently. So a box that
# still has one is refused. A box before Recall v2 has no node_id column: all
# of its maps are page-built. ROLL_ALLOW_V1_RECALL=1 overrides, for a map the
# owner agreed may go (or a roll to a tag before R5).
V1=$(rsh 'sh -s' <<'EOF'
set -e
q() { docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At -c "$1"; }
if [ "$(q "select to_regclass('public.recall_maps') is not null")" != t ]; then exit 0; fi
if [ "$(q "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'recall_maps' and column_name = 'node_id'")" = 1 ]; then
  q "select coalesce(string_agg(slug, ' ' order by slug), '') from recall_maps where node_id is null"
else
  q "select coalesce(string_agg(slug, ' ' order by slug), '') from recall_maps"
fi
EOF
) || die "could not check for page-built Recall maps"
V1=$(printf '%s' "$V1" | tr -d '\r')
if [ -n "$V1" ]; then
  if [ "${ROLL_ALLOW_V1_RECALL:-}" = 1 ]; then
    echo "recall: page-built map(s) left, allowed by ROLL_ALLOW_V1_RECALL=1: $V1"
  else
    die "page-built Recall map(s) still on this box: $V1. Retire them first (untag the root on the current release, then move the slug onto the native map; docs/update-prod.md), or set ROLL_ALLOW_V1_RECALL=1 if the owner agreed they may go."
  fi
else
  echo "recall: no page-built maps"
fi

# ── 2c. connectors by level: what the roll opens ────────────────────────────
# From team apps Phase 2 a connector's level decides who may use its tools,
# and a tool without the admin's read-only mark can change data: on a
# connector already below admin (set for the team assistant in chat) every
# unmarked tool becomes callable as a write by members' apps and MCP the
# moment the box rolls. Counted here in plain SQL (the box's current image
# may not have the connector-levels script yet), numbers only, read only.
# The roll stops while any such write would open, unless the operator passed
# --ack-connector-writes after an admin looked (mark the tools read-only,
# disable them, or raise the connector to admin level first).
# Only the roll that CROSSES into connectors by level counts (M3 audit): a
# box whose database already has apps.author_level (migration 0235, shipped
# with connectors by level) is past it, so its later rolls open nothing new
# and need no acknowledgement. SELECT only, digits only.
CW=$(rsh 'sh -s' <<'EOF'
set -e
q() { docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At -F ' ' -c "$1"; }
if [ "$(q "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'tools' and column_name = 'external_access'")" != 1 ]; then
  echo "0 0 0 0"; exit 0
fi
if [ "$(q "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'apps' and column_name = 'author_level'")" = 1 ]; then
  echo "1 0 0 0"; exit 0
fi
q "with g as (
     select slug from tool_groups
      where integration ? 'mcp' and enabled and audience <> 'admin'),
   w as (
     select t.slug from tools t join g on g.slug = t.handler->>'group'
      where t.handler->>'kind' = 'mcp' and t.enabled and not t.requires_confirm
        and t.external_access is null)
   select 0, (select count(*) from g), (select count(*) from w),
          (select count(*) from apps a join nodes n on n.id = a.node_id
            where (n.audience <> 'admin' or n.inherited_level is not null)
              and exists (select 1 from w where a.manifest->'toolSlugs' ? w.slug))"
EOF
) || die "could not count the connectors below admin"
CW=$(printf '%s' "$CW" | tr -d '\r' | tr -s ' ')
case "$CW" in *[!0-9\ ]* | '') die "unexpected connector count: $CW" ;; esac
read -r PAST OPEN_GROUPS OPEN_WRITES APPS_OPENING <<< "$CW"
[ "$PAST" = 1 ] && echo "connectors: this box already has connectors by level; nothing new opens"
echo "connectors below admin: $OPEN_GROUPS, unmarked (write) tools in them: $OPEN_WRITES, apps below admin declaring one: $APPS_OPENING"
if [ "$OPEN_WRITES" -gt 0 ] || [ "$APPS_OPENING" -gt 0 ]; then
  if [ -n "$ACK_CONNECTOR_WRITES" ]; then
    echo "connectors: write tools open after this roll, acknowledged by --ack-connector-writes"
  else
    die "this roll opens $OPEN_WRITES connector write tool(s) to members, clients or apps ($APPS_OPENING app(s) below admin declare one). Have an admin mark them read-only, disable them, or raise their connector to admin level; or pass --ack-connector-writes if Jason agreed."
  fi
fi

# ── 2c (2). run-time schema SQL that rows-only breaks ─────────────────────
# From team apps Phase 3 a member's, client's or contact's write runs rows
# only: CREATE TABLE / CREATE INDEX IF NOT EXISTS on an object that exists is
# a no-op, but any other create, ALTER, DROP, PRAGMA, transaction control,
# VACUUM, REINDEX or ANALYZE run through host.db.exec is refused for them.
# Counted on the live published apps' source text: total, below admin (what
# members, clients or contacts run), with a live share link. Same boundary
# rule as above: only the roll that crosses into it. SELECT only, digits
# only; --app-ddl-ids prints the ids of those below admin for a follow-up.
# A LOWER BOUND: it matches only a literal `host.db.exec(` with the SQL
# written right there. An app that aliases the bridge (`const exec =
# host.db.exec`), builds the SQL in a variable, or wraps it in its own
# helper is not counted; read such an app's source when it matters.
# Apps must declare their schema (app_db_schema_set) instead.
# The remote script is read into a variable first: its regex holds an
# unbalanced parenthesis, which a heredoc inside $( ) cannot carry on older
# bash.
IFS= read -r -d '' DDL_SCRIPT <<'EOF' || true
set -e
q() { docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At -F ' ' -c "$1"; }
if [ "$(q "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'apps' and column_name = 'author_level'")" = 1 ]; then
  echo "1 0 0 0"; exit 0
fi
BREAKS="a.source_text ~* 'host\.db\.exec\s*\(\s*.\s*(alter|drop|pragma|begin|commit|end|rollback|savepoint|release|vacuum|reindex|analyze|create\s+(?!(unique\s+)?(table|index)\s+if\s+not\s+exists))'"
LIVE="(a.published_build->>'ok')::boolean is true"
BELOW="(n.audience <> 'admin' or n.inherited_level is not null)"
if [ -n "$APP_DDL_IDS" ]; then
  q "select n.id from apps a join nodes n on n.id = a.node_id where $LIVE and $BELOW and $BREAKS order by n.id"
  exit 0
fi
q "select 0,
     count(*),
     count(*) filter (where $BELOW),
     count(*) filter (where exists (select 1 from shares s where s.node_id = n.id and s.revoked_at is null))
   from apps a join nodes n on n.id = a.node_id where $LIVE and $BREAKS"
EOF
DDL=$(printf '%s' "$DDL_SCRIPT" | rsh "APP_DDL_IDS='$APP_DDL_IDS' sh -s") ||
  die "could not count the apps with run-time schema SQL"
DDL=$(printf '%s' "$DDL" | tr -d '\r')
if [ -n "$APP_DDL_IDS" ]; then
  case "$DDL" in *[!0-9a-f$'\n'-]*) die "unexpected app id list" ;; esac
  printf 'apps below admin whose run-time schema SQL breaks after this roll:\n%s\n' "${DDL:-(none)}"
  exit 0
fi
DDL=$(printf '%s' "$DDL" | tr -s ' ')
case "$DDL" in *[!0-9\ ]* | '') die "unexpected app DDL count: $DDL" ;; esac
read -r DDL_PAST DDL_TOTAL DDL_BELOW DDL_SHARED <<< "$DDL"
[ "$DDL_PAST" = 1 ] && echo "app schema SQL: this box already runs rows only below admin"
echo "live apps with run-time schema SQL: $DDL_TOTAL, below admin: $DDL_BELOW, with a live share link: $DDL_SHARED"
if [ "$DDL_BELOW" -gt 0 ] || [ "$DDL_SHARED" -gt 0 ]; then
  if [ -n "$ACK_APP_DDL" ]; then
    echo "app schema SQL: acknowledged by --ack-app-ddl"
  else
    die "$DDL_BELOW live app(s) below admin ($DDL_SHARED with a share link) run schema SQL through host.db.exec that members, clients and contacts can no longer run. Declare their schema (app_db_schema_set) first, list them with --app-ddl-ids, or pass --ack-app-ddl if Jason agreed."
  fi
fi

# ── 2d. the checks' floor: both checks on before the pre-checks go ────────
# From the release that removes the tools' TypeScript item pre-checks (the
# migration named *_check_mode_floor.sql; docs/actors.md, "Pre-check
# deletion") the database's actor and edit checks are a tool write's only
# item check, and that release's migrate raises a check below on that no
# recorded lowering covers (docs/update-prod.md, "The checks' floor"). A
# roll is never how a box's checks change: a box below on is refused unless
# its stack .env says MANTLE_CHECK_FLOOR=keep (kept below on on purpose: its
# migrate leaves it and records why), or the TARGET release does not ship
# the floor. No release number is written here: whether the target ships it
# is read from the target's own tree (its tag in this checkout, or
# ROLL_RELEASE_GIT's), the migration file by its name. A target this
# checkout cannot tell (`latest`, a tag not fetched) counts as shipping it.
# CHECK_FLOOR_NOT_BEFORE only skips the question for a release older than
# any that could ship it (the floor was written on v0.300.81). The modes are
# plain SQL on the box's CURRENT schema (a box before 0280 has no
# mantle_check_box_mode: both off), words only; the updater asks the same
# SQL (infra/updater/updater.sh, check_floor_refusal), pinned equal by
# packages/db/src/check-floor-preflight.db.test.ts.
CHECK_FLOOR_NOT_BEFORE=0.300.82
check_modes_sql() {
  cat <<'CHECK_MODES_SQL'
select case when to_regprocedure('public.mantle_check_box_mode(text)') is null then 'off off'
            else (xpath('/row/m/text()', query_to_xml(
              'select public.mantle_check_box_mode(''actor_check'') || '' '' || '
              || 'public.mantle_check_box_mode(''edit_check'') as m', false, true, '')))[1]::text
       end;
CHECK_MODES_SQL
}
# floor_in_release <tag>: yes when release <tag>'s tree holds the floor's
# migration, no when it does not, unknown when this checkout has no such tag.
floor_in_release() {
  local git_dir=${ROLL_RELEASE_GIT:-$ROOT} ref names
  for ref in "refs/tags/v${1#v}" "refs/tags/$1"; do
    git -C "$git_dir" rev-parse -q --verify "$ref^{commit}" > /dev/null 2>&1 || continue
    names=$(git -C "$git_dir" ls-tree --name-only "$ref" packages/db/migrations/ 2> /dev/null) || {
      echo unknown
      return 0
    }
    case "$names" in
      *_check_mode_floor.sql*) echo yes ;;
      *) echo no ;;
    esac
    return 0
  done
  echo unknown
}
if tag_at_or_past "$CHECK_FLOOR_NOT_BEFORE" "$TAG"; then
  CF=$(check_modes_sql | rsh "docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At") ||
    die "could not read this box's check modes"
  CF=$(printf '%s' "$CF" | tr -d '\r' | tr -s ' ')
  case "$CF" in off\ off | off\ warn | off\ on | warn\ off | warn\ warn | warn\ on | on\ off | on\ warn | on\ on) ;;
    *) die "unexpected check modes: $CF" ;; esac
  read -r CF_ACTOR CF_EDIT <<< "$CF"
  CF_KEEP=$(rsh "sed -n 's/^MANTLE_CHECK_FLOOR=//p' '$STACK/.env' 2>/dev/null | tail -1" || true)
  CF_KEEP=$(printf '%s' "$CF_KEEP" | tr -d '\r"'"'"' ' | tr '[:upper:]' '[:lower:]')
  echo "checks: actor $CF_ACTOR, edit $CF_EDIT (MANTLE_CHECK_FLOOR: ${CF_KEEP:-raise})"
  if [ "$CF_ACTOR" != on ] || [ "$CF_EDIT" != on ]; then
    if [ "$CF_KEEP" = keep ]; then
      echo "checks: below on, kept on purpose (MANTLE_CHECK_FLOOR=keep in $STACK/.env): the roll's migrate leaves them and records why"
    else
      CF_SHIPS=$(floor_in_release "$TAG")
      CF_HOW="Turn them on first (docs/edit-check.md: select mantle_set_actor_check('on'); select mantle_set_edit_check('on');), or keep this box below on on purpose: MANTLE_CHECK_FLOOR=keep and MANTLE_CHECK_FLOOR_REASON in its .env (docs/update-prod.md, \"Keep one box below on, on purpose\")."
      case "$CF_SHIPS" in
        no) echo "checks: below on, and $TAG does not ship the checks' floor (no *_check_mode_floor.sql in its tree): not refused" ;;
        yes) die "this box's checks are not both on (actor $CF_ACTOR, edit $CF_EDIT), and $TAG ships the checks' floor: the tools' item pre-checks are gone there and the roll's migrate would raise them. $CF_HOW" ;;
        *) die "this box's checks are not both on (actor $CF_ACTOR, edit $CF_EDIT), and this checkout cannot tell whether $TAG ships the checks' floor (no such tag here: git fetch --tags), so it counts as shipping it. $CF_HOW" ;;
      esac
    fi
  fi
else
  echo "checks: $TAG is older than any release with the checks' floor (v$CHECK_FLOOR_NOT_BEFORE); not checked"
fi

if [ -n "$DRY" ]; then
  echo "dry run: stopping before the backup and the request"
  exit 0
fi

# ── 3. backup ────────────────────────────────────────────────────────────────
UPDATER_DUMPS=""
if rsh "grep -q '^pre_roll_backup()' '$STACK/infra/updater/updater.sh'" 2>/dev/null \
  && ! rsh "grep -q '^MANTLE_PRE_ROLL_BACKUP=0' '$STACK/.env'" 2>/dev/null; then
  UPDATER_DUMPS=1
  echo "backup: the updater takes a strict pre-roll backup itself (backups/pre-roll)"
else
  echo "▶ backup: scripts/db-dump.sh (strict)"
  DUMP_LOG=$(mktemp)
  trap 'rm -f "$DUMP_LOG"' EXIT
  # Its own exit status: output goes to a file, not through a pipe.
  if ! rsh "cd '$STACK' && MANTLE_DUMP_STRICT=1 bash scripts/db-dump.sh" > "$DUMP_LOG" 2>&1; then
    cat "$DUMP_LOG"
    die "BACKUP FAILED: db-dump.sh exited non-zero. Nothing was requested."
  fi
  cat "$DUMP_LOG"
  # A box whose db-dump.sh predates strict mode reports a lost part and exits 0.
  if grep -qE 'NOT backed up|FAILED' "$DUMP_LOG"; then
    die "BACKUP INCOMPLETE: a part was not backed up (see above). Nothing was requested."
  fi
  grep -q '✔ Wrote .*mantle-[0-9-]*\.dump' "$DUMP_LOG" || die "BACKUP FAILED: no Postgres dump reported. Nothing was requested."
fi

# ── 4. request ───────────────────────────────────────────────────────────────
echo "▶ requesting $TAG at $(date -u +%H:%M:%SZ) (previous started_at: ${OLD_STARTED:-none})"
rsh 'sh -s' <<EOF || die "REQUEST FAILED: could not write request.json"
set -e
docker run --rm -i -v "$SIGDIR:/s" alpine sh -c 'cat > /s/request.json.tmp && mv /s/request.json.tmp /s/request.json' <<'REQ'
{"target":"$TAG"}
REQ
EOF

# ── 5. wait for THIS run to finish ───────────────────────────────────────────
S=""; waited=0
while :; do
  S=$(status_json)
  if [ "$(printf '%s' "$S" | field target)" = "$TAG" ] \
    && [ "$(printf '%s' "$S" | field started_at)" != "$OLD_STARTED" ] \
    && [ -n "$(printf '%s' "$S" | field finished_at)" ]; then
    break
  fi
  [ "$waited" -ge "$TIMEOUT" ] && die "TIMED OUT after ${TIMEOUT}s waiting for the roll; last status: $S"
  sleep "$POLL"; waited=$((waited + POLL))
  [ "$POLL" -gt 0 ] || waited=$((waited + 1))
done
echo "status: $S"
if ! printf '%s' "$S" | grep -q '"ok":true'; then
  rsh docker exec mantle_updater tail -n 30 /signal/update.log 2>/dev/null || true
  die "ROLL NOT OK: $(printf '%s' "$S" | field error)"
fi
if [ -n "$UPDATER_DUMPS" ]; then
  # One string: ssh joins its arguments, so separate quoted words lose their
  # quotes on the box and grep reads "backup" and "ok" as file names.
  rsh "docker exec mantle_updater grep -q 'pre-roll backup ok' /signal/update.log" 2>/dev/null \
    || die "the roll finished but update.log shows no pre-roll backup; check backups/pre-roll by hand"
fi

# ── 6. health ────────────────────────────────────────────────────────────────
# A web that never comes up is the worst roll outcome (v0.300.64: every server
# process crash-looped at start on an import error), so say it loudly and show
# why: the tail of its own log, every line of it, with secret VALUES masked
# (dropping whole lines hid the very lines that explain a boot failure, like
# "SESSION_SECRET must be at least 32 characters", and still let a URL with a
# password through). Each line is cut to 2000 characters first (" [cut]" marks
# it): the name rule below backtracks quadratically on a hostile line, and a
# 100k-character "keykeykey..." took minutes; cut, it takes milliseconds. A cut
# line also loses its last partial token after masking (everything after the
# last space, comma, semicolon or quote), so a secret the cut runs through (a
# URL password, a 64-hex key, a ghp_ token too short now for its rule) never
# prints its first half.
# Masked: URL credentials (scheme://user:pass@ -> scheme://[redacted]@; for
# postgres, postgresql, redis, rediss, mysql, mssql, sqlserver, amqp, amqps,
# mongodb and mongodb+srv up to the LAST @ before a space or quote, and for any
# other scheme when a user:password pair opens it, so a password holding an
# unencoded / or @ is masked whole; https://example.com/a/b@c has no pair, and
# a host:port (1 to 5 digits, then /, ?, # or the end) is no pair, so
# http://localhost:3000/api/users/@me and an npm @scope path print whole),
# the rest of an Authorization or Cookie header, the word after "Bearer", the
# value after --password, --token and the like (--db-password X,
# a quoted "two words" whole), a PEM or PGP private key block (its BEGIN line
# and END line print as [redacted]; when BEGIN ends its line, or ends it with
# a literal \n, a quote and a + (a key in a Node-inspected object prints as
# quoted lines joined by +), the lines after it that look like key body,
# base64, =checksum, Proc-Type:, DEK-Info:, Version: and the like, bare or
# quoted that way, print as [redacted] too, at most 200, and the first
# line that does not ends the block and is masked as any other line, so an
# error that quotes "-----BEGIN RSA PRIVATE KEY-----" or a one-line JSON key cut
# before its END cannot swallow the stack trace after it; a line that is
# nothing but a 40+ character base64 run prints as [redacted] too, so a log
# tail that starts inside a block is masked), a bare token wherever it stands
# (sk-ant-, sk-or-, sk-proj-, sk-svcacct-, sk-admin-, any sk- with 20 or more
# characters after it, sk_live_, sk_test_, rk_live_, rk_test_, ghp_ and its
# gho_/ghs_/ghu_/ghr_ siblings, github_pat_, xoxb-, xoxp-, xoxa- and the other
# Slack xox?- kinds, xapp-, whsec_, glpat-, npm_, hf_, a SendGrid SG.x.y key,
# an AWS AKIA/ASIA key id, mtlk_...
# dashes included, a JWT eyJ..., a Telegram bot token, a 64-hex string), and
# the value after a name
# holding key, token, secret, passw..., pwd, authorization, cookie, bearer or
# session (word characters and dashes may finish it), or the name pass exactly
# (SMTP_PASS=, "pass":), when the = or : comes RIGHT after that name (a
# closing quote and spaces may come between). A quoted value is masked to its
# real closing quote, past escaped ones, or to the end of the line when it has
# none (a cut line); a value quoted with escaped quotes (JSON inside a JSON
# string: "{\"apiKey\":\"a b\"}") is masked to its closing \". Anchoring the
# name to its separator keeps the lines that explain a crash whole: a stack
# frame (secrets.ts:44:11), a Zod "Required" next to a key path, a
# "[token-refresh] failed: connect ECONNREFUSED", "tests passed:".
# Case-insensitive; perl, not sed: BSD sed has no case-insensitive flag. $pem
# is a package variable on purpose: it carries the open block across lines.
REDACT_PERL='
my $cut = s{\A(.{2000}).+}{$1};
if ($pem) { if (s{\A[\s\x22\x27A-Za-z0-9+/=]*-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----}{\[redacted\]}) { $pem = 0 } elsif ($pem++ <= 200 && /\A\s*[\x22\x27]?(?:[A-Za-z0-9+\/]+={0,2}|=[A-Za-z0-9+\/]+|(?:Proc-Type|DEK-Info|Version|Comment|Hash|Charset):.*)?(?:\\n)?[\x22\x27]?\s*\+?\s*\z/) { s{.*}{\[redacted\]} } else { $pem = 0 } }
s{-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----.*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----}{\[redacted\]}g;
if (s{-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----(.*)}{\[redacted\]}) { $pem = 1 if $1 =~ /\A(?:\s*|\\n[\x22\x27]\s*\+\s*)\z/ }
s{\A(\s*)[A-Za-z0-9+/]{40,}={0,2}(\s*)\z}{$1\[redacted\]$2};
s{\b(?:sk-(?:ant|or|proj|svcacct|admin)-[\w-]{8,}|sk-[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_\w{8,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[abeoprs]-[\w-]{8,}|xapp-[\w-]{8,}|whsec_\w{8,}|glpat-[\w-]{8,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|SG\.[\w-]{16,}\.[\w-]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16}|mtlk_[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]*)}{\[redacted\]}g;
s{(/bot)\d+:[\w-]+}{$1\[redacted\]}g;
s{\b\d{6,}:[A-Za-z0-9_-]{30,}}{\[redacted\]}g;
s{\b[0-9a-fA-F]{64}\b}{\[redacted\]}g;
s{\b((?:postgres(?:ql)?|rediss?|mysql|mssql|sqlserver|amqps?|mongodb(?:\+srv)?)://)[^\s\x22\x27]*\@}{$1\[redacted\]\@}gi;
s{://[^/\s\@:\x22\x27]+:(?!\d{1,5}(?:[/?#]|\z))[^\s\x22\x27]*\@}{://[redacted]\@}g;
s{://[^/\s\@]+\@}{://[redacted]\@}g;
s{\b((?:proxy-)?authorization|(?:set-)?cookie)(\s*[=:]\s*).*}{$1$2\[redacted\]}gi;
s{\b(bearer)\s+[^\s,;\x22\x27]+}{$1 \[redacted\]}gi;
s{((?<![\w-])--[\w-]*?(?:passw[a-z]*|pwd|pass|token|secret|key)\s+)(?:\x22[^\x22\n]*+(?:\x22|$)|\x27[^\x27\n]*+(?:\x27|$)|[^\s,;]+)}{$1\[redacted\]}gi;
s{((?:(?:key|token|secret|passw[a-z]*|pwd|authorization|cookie|bearer|session)[\w-]*+|pass)(?:\\?\x22|\x27)?\s*[=:]\s*)(?:\x22(?:[^\x22\\\n]|\\.)*+(?:\x22|$)|\x27(?:[^\x27\\\n]|\\.)*+(?:\x27|$)|\\\x22(?:[^\\\x22\n]|\\[^\\\x22\n]|\\\\(?:\\.|[^\\\x22\n]))*+(?:\\\x22|$)|[^\s,;]+)}{$1\[redacted\]}gi;
s{[^\s,;\x22\x27]*(?=\n?\z)}{} if $cut;
s{(?=\n?\z)}{ [cut]} if $cut;
'
redact_secrets() { perl -pe "$REDACT_PERL"; }
web_not_healthy() { # <last health status>
  local logs
  printf '\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' >&2
  printf '!!  WEB NOT HEALTHY on %s %ss after the roll to %s (last: %s).\n' \
    "$SSH_ALIAS" "$HEALTH_TIMEOUT" "$TAG" "${1:-unknown}" >&2
  printf '!!  The box is DOWN or degraded. Nothing was rolled back. Roll nothing\n' >&2
  printf '!!  else; read the log below, then fix forward or roll back by hand\n' >&2
  printf '!!  (docs/update-prod.md). The pre-roll backup is the way back.\n' >&2
  printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' >&2
  logs=$(rsh "docker logs --tail 20 mantle_web 2>&1" 2>/dev/null) || logs=""
  if [ -z "$logs" ]; then
    printf '(could not read the mantle_web log on %s)\n' "$SSH_ALIAS" >&2
  elif ! command -v perl >/dev/null 2>&1; then
    printf '(perl not found: the log cannot be masked, so it is not shown; read it on the box:\n' >&2
    printf '  ssh %s docker logs --tail 20 mantle_web)\n' "$SSH_ALIAS" >&2
  else
    printf 'last lines of the mantle_web log (secret values masked):\n' >&2
    printf '%s\n' "$logs" | redact_secrets | sed 's/^/    /' >&2 || true
  fi
  exit 1
}
HS=""; waited=0
while :; do
  HS=$(rsh "docker inspect -f '{{.State.Health.Status}}' mantle_web" 2>/dev/null || true)
  [ "$HS" = healthy ] && break
  [ "$waited" -ge "$HEALTH_TIMEOUT" ] && web_not_healthy "$HS"
  sleep "$POLL"; waited=$((waited + POLL))
  [ "$POLL" -gt 0 ] || waited=$((waited + 1))
done
echo "mantle_web: $HS"

# ── 7. counts after ──────────────────────────────────────────────────────────
C1=$(counts) || die "could not count apps / sandboxes / app-db files after the roll"
read -r APPS1 SBX1 FILES1 <<< "$C1"
echo "after:  apps=$APPS1 sandboxes=$SBX1 app-db files=$FILES1"
DROPS=""
[ "$APPS1" -ge "$APPS0" ] || DROPS="$DROPS apps ${APPS0}→${APPS1};"
[ "$SBX1" -ge "$SBX0" ] || DROPS="$DROPS sandboxes ${SBX0}→${SBX1};"
[ "$FILES1" -ge "$FILES0" ] || DROPS="$DROPS app-db files ${FILES0}→${FILES1};"
if [ -n "$DROPS" ]; then
  printf '\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' >&2
  printf '!!  COUNTS DROPPED on %s after the roll to %s:%s\n' "$SSH_ALIAS" "$TAG" "$DROPS" >&2
  printf '!!  STOP. Roll nothing else. The pre-roll backup is the way back.\n' >&2
  printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' >&2
  exit 3
fi

# ── 8. version ───────────────────────────────────────────────────────────────
if [ -n "$URL" ]; then
  echo "version: $(curl -fsS --max-time 10 "$URL/api/version" || echo '(unreachable)')"
else
  echo "version: $(rsh 'sh -s' <<'EOF' || echo '(unreadable)'
docker exec mantle_web node -e "fetch('http://127.0.0.1:3000/api/version').then((r) => r.text()).then((t) => console.log(t))"
EOF
  )"
fi
echo "✔ $SSH_ALIAS rolled to $TAG; apps, sandboxes and app-db files intact"
