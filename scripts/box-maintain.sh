#!/usr/bin/env bash
#
# box-maintain.sh: run ONE long `pnpm maintain` task on a box in its own
# throwaway container, never inside mantle_web.
#
# Why (2026-10-04, a 314k-window chunk-windows backfill took four tries):
#   - `nohup docker exec ... &` over ssh died with the ssh session: its output
#     pipe belonged to the session, and the log just stopped.
#   - `docker exec` runs inside mantle_web's memory limit: the task and the
#     live web tier share one cgroup, so a big task OOM-kills itself (or
#     pushes the web tier out).
# A sibling container owns its process tree, its log and its memory limit:
#   - the box's own image (the one mantle_web runs), mantle_web's working dir,
#     and mantle_web's network namespace (`--network container:mantle_web`),
#     so it reaches Postgres and the providers exactly as the web tier does;
#   - mantle_web's volumes READ-ONLY (`--volumes-from mantle_web:ro`), so a
#     task can read file bytes from /data/files like the web tier (ocr-rescan
#     counted every PDF as unreadable without it) but cannot write there;
#   - mantle_web's env, handed over through a pipe (`--env-file /dev/fd/N`),
#     never written to disk;
#   - its own `--memory` (default 2g, no swap) and a Node heap cap at 75% of
#     it, so a runaway task dies alone and says why;
#   - output to `docker logs maint-<task>` while it runs, AND to a log file
#     on the box (~/maint-logs, mode 600) that outlives the container, which
#     removes itself when it exits (`--rm`);
#   - one run per box: refused while another maint container runs, or while
#     a `pnpm maintain` runs inside mantle_web.
#
# Usage:
#   scripts/box-maintain.sh [options] <box-label> <task> [task args...]
#   scripts/box-maintain.sh [options] --ssh <alias> <task> [task args...]
#   scripts/box-maintain.sh [options] --here <task> [task args...]
#   scripts/box-maintain.sh <box-label | --ssh <alias> | --here> --status | --logs | --follow | --stop
#
#   --memory=<size>  container memory cap (default 2g)
#   --heap=<MB>      Node heap cap (default 75% of --memory)
#   --owner=<uuid>   ALLOWED_USER_ID (default: mantle_web's, else the brain's
#                    anchor from Postgres, mantle_brain_id())
#   --web=<name>     the web container to copy (default mantle_web)
#   --pg=<name>      the Postgres container for the owner lookup (default mantle_pg)
#
# Options go BEFORE the task; everything after the task goes to
# `pnpm maintain <task>` unchanged (so `--apply --yes --parallel=16` are the
# task's flags, with the runner's usual spend brake).
#
# <box-label> is looked up in .mantle-fleet.json at the repo root (untracked,
# see .mantle-fleet.example.json; MANTLE_FLEET_FILE points elsewhere), as
# scripts/roll.sh does. --here runs the docker commands on this machine (you
# are already on the box). Hostnames never live in this script.
#
# Examples:
#   scripts/box-maintain.sh mybox chunk-windows                      # dry run
#   scripts/box-maintain.sh mybox chunk-windows --apply --yes --parallel=16
#   scripts/box-maintain.sh mybox --follow                           # watch it
#   scripts/box-maintain.sh --memory=3g mybox re-embed --model=<id> --yes
#
# Exit codes: 0 started (or the status action worked), 1 refused or failed,
# 2 usage.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)

die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
usage() { sed -n '/^# Usage:/,/^# Exit codes/p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

MEM=2g; HEAP=""; OWNER=""; WEB=mantle_web; PG=mantle_pg
SSH_ALIAS=""; HERE=""; LABEL=""; ACTION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --memory=*) MEM=${1#*=}; shift ;;
    --heap=*) HEAP=${1#*=}; shift ;;
    --owner=*) OWNER=${1#*=}; shift ;;
    --web=*) WEB=${1#*=}; shift ;;
    --pg=*) PG=${1#*=}; shift ;;
    --ssh) SSH_ALIAS=${2:-}; shift 2 ;;
    --here) HERE=1; shift ;;
    --status | --logs | --follow | --stop) ACTION=${1#--}; shift; break ;;
    -h | --help) usage ;;
    -*) echo "unknown option: $1 (options go before the task)" >&2; usage ;;
    *)
      if [ -z "$SSH_ALIAS" ] && [ -z "$HERE" ] && [ -z "$LABEL" ]; then
        LABEL=$1; shift
      else
        ACTION=run; break
      fi ;;
  esac
done
[ -n "$ACTION" ] || usage
TASK=""
if [ "$ACTION" = run ]; then
  TASK=$1; shift
  # The task names the container and reaches a remote shell.
  case "$TASK" in '' | *[!a-z0-9-]*) die "invalid task slug: $TASK" ;; esac
fi

# Values that reach a remote shell or a docker flag: plain characters only.
case "$MEM" in *[!0-9kmgKMG]* | '') die "invalid --memory: $MEM" ;; esac
case "$HEAP" in *[!0-9]*) die "invalid --heap: $HEAP" ;; esac
case "$OWNER" in *[!0-9a-fA-F-]*) die "invalid --owner: $OWNER" ;; esac
for n in "$WEB" "$PG"; do
  case "$n" in '' | *[!A-Za-z0-9_.-]*) die "invalid container name: $n" ;; esac
done
if [ -z "$HEAP" ]; then
  num=${MEM%[kmgKMG]}; unit=${MEM#"$num"}
  case "$unit" in
    g | G) HEAP=$((num * 1024 * 3 / 4)) ;;
    m | M) HEAP=$((num * 3 / 4)) ;;
    *) die "--memory needs a unit (m or g), or pass --heap" ;;
  esac
fi

# ── the box ──────────────────────────────────────────────────────────────────
if [ -n "$LABEL" ]; then
  FLEET=${MANTLE_FLEET_FILE:-$ROOT/.mantle-fleet.json}
  [ -f "$FLEET" ] || die "no $FLEET: pass --ssh <alias> or --here, or add the box there"
  command -v node >/dev/null || die "node is needed to read $FLEET"
  # shellcheck disable=SC2016  # JavaScript, not shell: nothing to expand
  SSH_ALIAS=$(node -e '
    const [file, label] = process.argv.slice(1);
    const raw = JSON.parse(require("fs").readFileSync(file, "utf8"));
    const boxes = Array.isArray(raw) ? raw : raw.boxes ?? [];
    const b = boxes.find((x) => x && x.label === label);
    if (!b) { console.error(`no box labelled "${label}" in ${file}`); process.exit(1); }
    console.log(b.ssh ?? "");
  ' "$FLEET" "$LABEL") || die "box lookup failed"
  [ -n "$SSH_ALIAS" ] || die "box \"$LABEL\" has no \"ssh\" in $FLEET"
fi
[ -n "$SSH_ALIAS" ] || [ -n "$HERE" ] || usage

# The box side, run by bash on the box with its arguments after `--`.
# shellcheck disable=SC2016  # expanded on the box, not here
BOX_SCRIPT='
set -euo pipefail
ACTION=$1 WEB=$2 PG=$3 MEM=$4 HEAP=$5 OWNER=$6 TASK=$7; shift 7
LOGDIR=$HOME/maint-logs
die() { printf "\n✗ %s\n" "$*" >&2; exit 1; }
running() { docker ps --filter label=mantle.maint=1 --format "{{.Names}}"; }
last_log() { ls -t "$LOGDIR"/*.log 2>/dev/null | head -1 || true; }

case "$ACTION" in
  status)
    r=$(running)
    if [ -n "$r" ]; then
      docker ps --filter label=mantle.maint=1 --format "running: {{.Names}} ({{.Status}})"
      docker stats --no-stream --format "memory: {{.MemUsage}}" $r
    else
      echo "no maintenance container running"
    fi
    l=$(last_log)
    if [ -n "$l" ]; then echo "last log: $l"; tail -n 3 "$l"; fi
    exit 0 ;;
  logs | follow)
    r=$(running | head -1)
    if [ -n "$r" ]; then
      if [ "$ACTION" = follow ]; then exec docker logs -f --tail 50 "$r"; fi
      exec docker logs --tail 200 "$r"
    fi
    l=$(last_log)
    [ -n "$l" ] || die "no maintenance container running and no log in $LOGDIR"
    echo "(not running; last log: $l)"
    exec tail -n 200 "$l" ;;
  stop)
    r=$(running)
    [ -n "$r" ] || { echo "no maintenance container running"; exit 0; }
    # SIGTERM, then SIGKILL after 30 s; --rm removes it. The tasks are
    # resumable: the next run picks up where this one stopped.
    docker stop -t 30 $r ;;
  run) ;;
  *) die "unknown action $ACTION" ;;
esac

# One maintain run per box (two at once OOM-restarted a web tier once).
r=$(running)
[ -z "$r" ] || die "a maintenance run is already going: $r. Watch it with --follow; one run per box."
docker inspect "$WEB" >/dev/null 2>&1 || die "no container $WEB on this box"
if docker top "$WEB" -eo pid,args 2>/dev/null | grep -q "[s]cripts/maintain\.ts"; then
  die "a pnpm maintain is running inside $WEB. Let it finish first; one run per box."
fi

IMAGE=$(docker inspect --format "{{.Image}}" "$WEB")
WORKDIR=$(docker inspect --format "{{.Config.WorkingDir}}" "$WEB")
[ -n "$WORKDIR" ] || WORKDIR=/app
web_env() { docker inspect --format "{{range .Config.Env}}{{println .}}{{end}}" "$WEB"; }

if [ -z "$OWNER" ]; then
  OWNER=$(web_env | sed -n "s/^ALLOWED_USER_ID=//p" | head -1)
fi
if [ -z "$OWNER" ]; then
  OWNER=$(docker exec "$PG" psql -U postgres -d postgres -Atc "select mantle_brain_id()" 2>/dev/null | tr -d "[:space:]") || true
fi
case "$OWNER" in
  ????????-????-????-????-????????????) ;;
  *) die "cannot resolve the owner id (got \"$OWNER\"); pass --owner=<uuid>" ;;
esac

mkdir -p "$LOGDIR"; chmod 700 "$LOGDIR"
NAME=maint-$TASK
TS=$(date -u +%Y%m%dT%H%M%SZ)
LOG=$NAME-$TS.log
# Inside the container: the run, teed to the log file, then its exit code.
# The log belongs to the box user (the image runs as root), mode 600.
INNER="set -o pipefail
: > /maint-logs/$LOG && chown $(id -u):$(id -g) /maint-logs/$LOG && chmod 600 /maint-logs/$LOG
pnpm maintain \"\$@\" 2>&1 | tee -a /maint-logs/$LOG
rc=\${PIPESTATUS[0]}
echo \"box-maintain: $NAME exited \$rc\" | tee -a /maint-logs/$LOG
exit \$rc"

# The env arrives through a pipe: docker reads /dev/fd/N, nothing on disk.
# mantle_web env first, then the overrides (-e wins over --env-file).
docker run -d --rm --init --name "$NAME" --label mantle.maint=1 \
  --memory "$MEM" --memory-swap "$MEM" \
  --network "container:$WEB" \
  --volumes-from "$WEB:ro" \
  --env-file <(web_env) \
  -e ALLOWED_USER_ID="$OWNER" \
  -e NODE_OPTIONS="--max-old-space-size=$HEAP" \
  -v "$LOGDIR:/maint-logs" \
  --workdir "$WORKDIR" \
  --entrypoint bash \
  "$IMAGE" -c "$INNER" maint "$TASK" "$@" >/dev/null

echo "started $NAME (memory $MEM, heap ${HEAP} MB, image ${IMAGE:7:12})"
echo "log on the box: $LOGDIR/$LOG"
sleep 3
if docker inspect "$NAME" >/dev/null 2>&1; then
  docker logs --tail 20 "$NAME" 2>&1 || true
else
  echo "(already finished)"; tail -n 20 "$LOGDIR/$LOG" || true
fi
'

ARGS=("$ACTION" "$WEB" "$PG" "$MEM" "$HEAP" "$OWNER" "${TASK:--}" "$@")
# The box script goes in on stdin (nothing to quote); ssh joins the arguments
# into one command line, so each is quoted.
if [ -n "$HERE" ]; then
  bash -s -- "${ARGS[@]}" <<< "$BOX_SCRIPT"
else
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_ALIAS" \
    "bash -s -- $(printf '%q ' "${ARGS[@]}")" <<< "$BOX_SCRIPT"
fi
if [ "$ACTION" = run ]; then
  WHERE=${LABEL:-${SSH_ALIAS:+--ssh $SSH_ALIAS}}
  WHERE=${WHERE:---here}
  [ "$WEB" = mantle_web ] || WHERE="--web=$WEB $WHERE"
  echo
  echo "Follow: scripts/box-maintain.sh $WHERE --follow"
  echo "Status: scripts/box-maintain.sh $WHERE --status"
fi
