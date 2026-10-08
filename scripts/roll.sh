#!/usr/bin/env bash
#
# roll.sh: roll ONE box to a release tag through its own updater, with the
# guards the fleet rules ask for, and stop loudly the moment one fails.
#
#   1. preflight: the updater is idle, no request is pending
#   2. count apps, sandboxes (Postgres) and app-db files (mantle_web) BEFORE;
#      refuse a box that still has a page-built (v1) Recall map (2b), and one
#      where the roll would open connector write tools to members, clients or
#      apps (2c, team apps Phase 2) unless --ack-connector-writes
#   3. backup: scripts/db-dump.sh on the box, strict, its OWN exit status
#      (no pipe in front of it). Skipped only when the box's updater takes
#      its own strict pre-roll backup (see pre_roll_backup in
#      infra/updater/updater.sh), which it then must have done.
#   4. request: request.json holding only {"target": <tag>}, written into the
#      updater's signal dir by a throwaway alpine container (the dir is
#      root-owned on the host), exactly as the in-app Update button would
#   5. wait for a NEW started_at with this target and a finished_at, ok:true
#   6. wait for mantle_web healthy
#   7. count again: ANY drop in apps, sandboxes or app-db files stops with a
#      loud error (mini sandbox apps are never to be lost in a roll)
#   8. print /api/version
#
# Usage:
#   scripts/roll.sh [--dry-run] [--ack-connector-writes] <box-label> <tag>
#   scripts/roll.sh [--dry-run] [--ack-connector-writes] --ssh <alias> [--stack <dir>] [--url <origin>] <tag>
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

DRY=""; ACK_CONNECTOR_WRITES=""; SSH_ALIAS=""; STACK=""; URL=""; LABEL=""; TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --ack-connector-writes) ACK_CONNECTOR_WRITES=1; shift ;;
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
CW=$(rsh 'sh -s' <<'EOF'
set -e
q() { docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At -F ' ' -c "$1"; }
if [ "$(q "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'tools' and column_name = 'external_access'")" != 1 ]; then
  echo "0 0 0"; exit 0
fi
q "with g as (
     select slug from tool_groups
      where integration ? 'mcp' and enabled and audience <> 'admin'),
   w as (
     select t.slug from tools t join g on g.slug = t.handler->>'group'
      where t.handler->>'kind' = 'mcp' and t.enabled and not t.requires_confirm
        and t.external_access is null)
   select (select count(*) from g), (select count(*) from w),
          (select count(*) from apps a join nodes n on n.id = a.node_id
            where (n.audience <> 'admin' or n.inherited_level is not null)
              and exists (select 1 from w where a.manifest->'toolSlugs' ? w.slug))"
EOF
) || die "could not count the connectors below admin"
CW=$(printf '%s' "$CW" | tr -d '\r' | tr -s ' ')
case "$CW" in *[!0-9\ ]* | '') die "unexpected connector count: $CW" ;; esac
read -r OPEN_GROUPS OPEN_WRITES APPS_OPENING <<< "$CW"
echo "connectors below admin: $OPEN_GROUPS, unmarked (write) tools in them: $OPEN_WRITES, apps below admin declaring one: $APPS_OPENING"
if [ "$OPEN_WRITES" -gt 0 ] || [ "$APPS_OPENING" -gt 0 ]; then
  if [ -n "$ACK_CONNECTOR_WRITES" ]; then
    echo "connectors: write tools open after this roll, acknowledged by --ack-connector-writes"
  else
    die "this roll opens $OPEN_WRITES connector write tool(s) to members, clients or apps ($APPS_OPENING app(s) below admin declare one). Have an admin mark them read-only, disable them, or raise their connector to admin level; or pass --ack-connector-writes if Jason agreed."
  fi
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
HS=""; waited=0
while :; do
  HS=$(rsh "docker inspect -f '{{.State.Health.Status}}' mantle_web" 2>/dev/null || true)
  [ "$HS" = healthy ] && break
  [ "$waited" -ge "$HEALTH_TIMEOUT" ] && die "WEB NOT HEALTHY after ${HEALTH_TIMEOUT}s (last: ${HS:-unknown})"
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
