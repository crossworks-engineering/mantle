#!/usr/bin/env bash
# The workstation CI runner loop (see README.md). One job per cycle:
#   1. a fresh Docker daemon in its own container (dind), on a private network;
#   2. a short-lived registration token from the host's gh login;
#   3. a fresh runner container that takes ONE job (--ephemeral) and exits;
#   4. both containers and their volumes are removed; the loop starts again.
# The runner container mounts no host folder and never sees the host's Docker
# socket, SSH keys or gh login: only the registration token, which can do
# nothing but register a runner, and expires within the hour.
#
# Usage: runner-loop.sh [slot]     (slot 1, 2, ... for parallel runners)
set -uo pipefail

SLOT=${1:-1}
REPO=${MANTLE_CI_REPO:-crossworks-engineering/mantle}
IMAGE=${MANTLE_CI_IMAGE:-mantle-ci-runner:2.338.2}
DIND_IMAGE=${MANTLE_CI_DIND_IMAGE:-docker:28-dind}
LABELS=${MANTLE_CI_LABELS:-mantle-ws}
CPUS=${MANTLE_CI_CPUS:-12}
MEM=${MANTLE_CI_MEM:-16g}
DIND_MEM=${MANTLE_CI_DIND_MEM:-6g}

P="mantle-ci-$SLOT"           # names: network, containers, volumes
NET="$P-net"; DIND="$P-dind"; RUNNER="$P-runner"
CERTS="$P-certs"; DATA="$P-data"

log() { printf '%s [ci-runner %s] %s\n' "$(date -u +%FT%TZ)" "$SLOT" "$*"; }

clean() {
  docker rm -f "$RUNNER" "$DIND" >/dev/null 2>&1
  docker volume rm -f "$CERTS" "$DATA" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  return 0
}
trap 'log "stopping"; clean; exit 0' INT TERM

while :; do
  clean
  docker network create "$NET" >/dev/null || { log "network create failed"; sleep 60; continue; }

  # The job's own Docker. Privileged is what a Docker daemon needs; it is the
  # one host-facing risk left (README.md, "What is still a risk").
  if ! docker run -d --name "$DIND" --privileged \
      --network "$NET" --network-alias dind \
      --memory "$DIND_MEM" \
      -e DOCKER_TLS_CERTDIR=/certs \
      -v "$CERTS:/certs" -v "$DATA:/var/lib/docker" \
      "$DIND_IMAGE" >/dev/null; then
    log "dind start failed"; sleep 60; continue
  fi
  for _ in $(seq 1 60); do
    docker exec "$DIND" docker info >/dev/null 2>&1 && break
    sleep 1
  done

  token=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token 2>/dev/null)
  if [ -z "$token" ]; then log "no registration token (gh login?)"; sleep 120; continue; fi

  log "waiting for a job"
  # The certs volume holds the client certs dind wrote; the runner reads them
  # read-only. Nothing from the host is mounted.
  docker run --name "$RUNNER" --rm \
    --network "$NET" \
    --cpus "$CPUS" --memory "$MEM" \
    -e DOCKER_HOST=tcp://dind:2376 -e DOCKER_TLS_VERIFY=1 -e DOCKER_CERT_PATH=/certs/client \
    -e RUNNER_TOKEN="$token" -e RUNNER_REPO="$REPO" -e RUNNER_LABELS="$LABELS" -e RUNNER_NAME="ws-$SLOT-$(date +%s)" \
    -v "$CERTS:/certs:ro" \
    "$IMAGE" bash -c '
      ./config.sh --unattended --ephemeral --disableupdate --replace \
        --url "https://github.com/$RUNNER_REPO" --token "$RUNNER_TOKEN" \
        --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work _work >/dev/null &&
      unset RUNNER_TOKEN && exec ./run.sh'
  log "runner exited ($?)"
  unset token
  sleep 2
done
