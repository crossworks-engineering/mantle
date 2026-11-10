#!/usr/bin/env bash
# runs-on: box. The CI workstation (Linux): bash, GNU tools.
# The workstation CI runner loop (see README.md). One job per cycle:
#   1. a fresh Postgres container on a private network (alias `pg`): the only
#      service build-check needs;
#   2. a short-lived registration token from the host's gh login;
#   3. a fresh runner container that takes ONE job (--ephemeral) and exits.
#      It gets no Docker at all: no socket, no daemon, no client certs. A job
#      that holds a Docker daemon can mount the host's disk; this one cannot;
#   4. both containers, their volume and the network are removed; again.
# The runner container mounts no host folder and never sees the host's SSH
# keys or gh login. Its job-started hook (guard-job.sh) refuses any job that
# is not a push run of build-check in this repo.
#
# Usage: runner-loop.sh [slot]     (slot 1, 2, ... for parallel runners)
set -uo pipefail

SLOT=${1:-1}
REPO=${MANTLE_CI_REPO:-crossworks-engineering/mantle}
IMAGE=${MANTLE_CI_IMAGE:-mantle-ci-runner:2.338.2}
PG_IMAGE=${MANTLE_CI_PG_IMAGE:-pgvector/pgvector:pg18}
LABELS=${MANTLE_CI_LABELS:-mantle-ws}
CPUS=${MANTLE_CI_CPUS:-12}
MEM=${MANTLE_CI_MEM:-16g}
PG_MEM=${MANTLE_CI_PG_MEM:-4g}
# The suites open many pools at once: a CI-style run peaked at 82 of the
# default 100 slots, and build-check failed on "remaining connection slots".
# Each slot is one backend process (pids-limit 1024) and a few MB of RAM.
PG_CONNS=${MANTLE_CI_PG_CONNS:-300}

P="mantle-ci-$SLOT"           # names: network, containers, volume
NET="$P-net"; PG="$P-pg"; RUNNER="$P-runner"; PGDATA="$P-pgdata"

log() { printf '%s [ci-runner %s] %s\n' "$(date -u +%FT%TZ)" "$SLOT" "$*"; }

clean() {
  docker rm -f "$RUNNER" "$PG" >/dev/null 2>&1
  docker volume rm -f "$PGDATA" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  return 0
}
child=""
stop() { log "stopping"; [ -n "$child" ] && kill "$child" 2>/dev/null; clean; exit 0; }
trap stop INT TERM

fails=0
backoff() { fails=$((fails + 1)); local s=$(( fails < 6 ? 30 * fails : 300 )); log "$1; next try in ${s}s"; sleep "$s"; }

while :; do
  clean
  docker network create "$NET" >/dev/null || { backoff "network create failed"; continue; }

  # The test database, same image and password as build-check's service on
  # GitHub. Nothing from the host; its data volume goes with the cycle.
  # --shm-size: Docker's 64 MB /dev/shm is small for parallel queries across
  # 300 backends (Postgres keeps its dynamic shared memory there).
  if ! docker run -d --name "$PG" --network "$NET" --network-alias pg \
      --memory "$PG_MEM" --pids-limit 1024 --shm-size 256m \
      -e POSTGRES_PASSWORD=postgres -v "$PGDATA:/var/lib/postgresql" \
      "$PG_IMAGE" -c max_connections="$PG_CONNS" >/dev/null; then
    backoff "postgres start failed"; continue
  fi
  ready=0
  for _ in $(seq 1 60); do
    # Over TCP: the unix socket also answers initdb's temporary server.
    docker exec "$PG" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && { ready=1; break; }
    sleep 1
  done
  [ "$ready" = 1 ] || { backoff "postgres not ready in 60s"; continue; }

  token=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token 2>/dev/null)
  [ -n "$token" ] || { backoff "no registration token (gh login?)"; continue; }

  log "waiting for a job"
  started=$(date +%s)
  # No Docker, no host mounts, no capabilities, no sudo (no-new-privileges).
  # The work folder and /tmp are anonymous volumes (removed with --rm), so
  # they are mounts as on GitHub's machines: the backup route refuses a folder on a
  # container's own overlay, and the route tests expect the VM's answer.
  # The token goes in through the environment of the docker client (`-e
  # RUNNER_TOKEN` with no value), not its command line, so `ps` on the host
  # does not show it.
  RUNNER_TOKEN="$token" docker run --name "$RUNNER" --rm \
    --network "$NET" \
    --cpus "$CPUS" --memory "$MEM" --pids-limit 8192 \
    --cap-drop ALL --security-opt no-new-privileges \
    -e RUNNER_TOKEN -e RUNNER_REPO="$REPO" -e RUNNER_LABELS="$LABELS" -e RUNNER_NAME="ws-$SLOT-$started" \
    -e MANTLE_TEST_NO_DOCKER=1 \
    -v /home/runner/_work -v /tmp \
    "$IMAGE" bash -c '
      ./config.sh --unattended --ephemeral --disableupdate --replace \
        --url "https://github.com/$RUNNER_REPO" --token "$RUNNER_TOKEN" \
        --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work _work >/dev/null &&
      unset RUNNER_TOKEN && exec ./run.sh' &
  child=$!
  unset token
  wait "$child"; rc=$?
  child=""
  log "runner exited ($rc)"
  # A runner that could not register or start (bad token, a runner version
  # GitHub no longer takes, a missing image) exits in seconds: back off
  # instead of minting a token every few seconds.
  if [ $(( $(date +%s) - started )) -lt 30 ]; then backoff "runner lived under 30s"; else fails=0; fi
done
