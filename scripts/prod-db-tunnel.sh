#!/usr/bin/env bash
# Open (or close) SSH tunnels from local ports to a remote Mantle's DATA PLANE —
# Postgres AND MinIO — so the local dev server (or a future Electron desktop app)
# runs as a thin client over the deployed brain. See docs/remote-db-dev.md.
#
# Both containers typically publish NO host port (they're only on the docker
# bridge), so we resolve their container IPs over SSH and forward to them. Those
# IPs can change when a container is recreated — this script re-resolves them
# every run, so you never hand-edit an address. Both forwards ride ONE ssh
# connection, so `down` drops them together.
#
# Usage:
#   scripts/prod-db-tunnel.sh [up|down|status]      (default: up)
#
# Config (env overrides — defaults match the reference deployment):
#   PROD_SSH_HOST          SSH host/alias               (default: mantle-prod)
#   MANTLE_PG_CONTAINER    Postgres container           (default: mantle_pg)
#   MANTLE_MINIO_CONTAINER MinIO container              (default: mantle_minio)
#   PROD_DB_LOCAL_PORT     local port → Postgres        (default: 55432)
#   PROD_S3_LOCAL_PORT     local port → MinIO           (default: 9100)
#
# Holds NO secrets. DB password + S3 keys live in apps/web/.env.local.
set -euo pipefail

PROD_SSH_HOST="${PROD_SSH_HOST:-mantle-prod}"
PG_CONTAINER="${MANTLE_PG_CONTAINER:-mantle_pg}"
MINIO_CONTAINER="${MANTLE_MINIO_CONTAINER:-mantle_minio}"
PG_LOCAL_PORT="${PROD_DB_LOCAL_PORT:-55432}"
MINIO_LOCAL_PORT="${PROD_S3_LOCAL_PORT:-9100}"
PG_REMOTE_PORT="${PG_REMOTE_PORT:-5432}"
MINIO_REMOTE_PORT="${MINIO_REMOTE_PORT:-9000}"
ACTION="${1:-up}"

# Our ssh always carries the Postgres forward — match on it for pid/status.
FORWARD_MATCH="ssh.*-L 127.0.0.1:${PG_LOCAL_PORT}:"

port_open()    { nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }
tunnel_pids()  { pgrep -f "$FORWARD_MATCH" 2>/dev/null || true; }
resolve_ip()   {
  ssh -o ConnectTimeout=15 "$PROD_SSH_HOST" \
    "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $1" \
    2>/dev/null | tr -d '[:space:]'
}

case "$ACTION" in
  up)
    if port_open "$PG_LOCAL_PORT"; then
      echo "✓ tunnel already up — 127.0.0.1:${PG_LOCAL_PORT} (pg) is listening."
      port_open "$MINIO_LOCAL_PORT" \
        && echo "✓ MinIO also up on 127.0.0.1:${MINIO_LOCAL_PORT}." \
        || echo "• MinIO port ${MINIO_LOCAL_PORT} not up — run 'down' then 'up' to (re)add it."
      exit 0
    fi

    echo "→ resolving container IPs on ${PROD_SSH_HOST}…"
    PG_IP="$(resolve_ip "$PG_CONTAINER")"
    if [ -z "$PG_IP" ]; then
      echo "✗ couldn't resolve ${PG_CONTAINER}'s IP on ${PROD_SSH_HOST}." >&2
      echo "  Check: ssh ${PROD_SSH_HOST} 'docker ps --filter name=${PG_CONTAINER}'" >&2
      exit 1
    fi
    MINIO_IP="$(resolve_ip "$MINIO_CONTAINER")"   # optional

    FORWARDS=(-L "127.0.0.1:${PG_LOCAL_PORT}:${PG_IP}:${PG_REMOTE_PORT}")
    echo "→ ${PG_CONTAINER} ${PG_IP}:${PG_REMOTE_PORT} → 127.0.0.1:${PG_LOCAL_PORT}"
    if [ -n "$MINIO_IP" ]; then
      FORWARDS+=(-L "127.0.0.1:${MINIO_LOCAL_PORT}:${MINIO_IP}:${MINIO_REMOTE_PORT}")
      echo "→ ${MINIO_CONTAINER} ${MINIO_IP}:${MINIO_REMOTE_PORT} → 127.0.0.1:${MINIO_LOCAL_PORT}"
    else
      echo "• ${MINIO_CONTAINER} not found — bringing up Postgres only (file/object access disabled)." >&2
    fi

    ssh -f -N \
      -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=3 \
      "${FORWARDS[@]}" \
      "$PROD_SSH_HOST"

    for _ in 1 2 3 4 5; do port_open "$PG_LOCAL_PORT" && break; sleep 0.5; done
    if port_open "$PG_LOCAL_PORT"; then
      echo "✓ Postgres tunnel up — DATABASE_URL host: 127.0.0.1:${PG_LOCAL_PORT}"
      [ -n "$MINIO_IP" ] && { port_open "$MINIO_LOCAL_PORT" \
        && echo "✓ MinIO tunnel up — S3_ENDPOINT: http://127.0.0.1:${MINIO_LOCAL_PORT}" \
        || echo "✗ MinIO port ${MINIO_LOCAL_PORT} didn't open." >&2; }
      echo "  (credentials live in apps/web/.env.local) — close with: scripts/prod-db-tunnel.sh down"
    else
      echo "✗ tunnel did not come up — is the SSH host reachable? (ssh ${PROD_SSH_HOST})" >&2
      exit 1
    fi
    ;;

  down)
    PIDS="$(tunnel_pids)"
    if [ -z "$PIDS" ]; then
      echo "• no tunnel on port ${PG_LOCAL_PORT} to close."
      exit 0
    fi
    # shellcheck disable=SC2086
    kill $PIDS 2>/dev/null || true
    echo "✓ closed tunnel (pg ${PG_LOCAL_PORT} + minio ${MINIO_LOCAL_PORT}; pids: $(echo "$PIDS" | tr '\n' ' '))"
    ;;

  status)
    rc=0
    if port_open "$PG_LOCAL_PORT"; then
      echo "✓ Postgres tunnel listening on ${PG_LOCAL_PORT} (pids: $(tunnel_pids | tr '\n' ' '))"
    else
      echo "✗ no Postgres tunnel on ${PG_LOCAL_PORT}."; rc=1
    fi
    port_open "$MINIO_LOCAL_PORT" \
      && echo "✓ MinIO tunnel listening on ${MINIO_LOCAL_PORT}" \
      || echo "✗ no MinIO tunnel on ${MINIO_LOCAL_PORT}."
    exit $rc
    ;;

  *)
    echo "usage: scripts/prod-db-tunnel.sh [up|down|status]" >&2
    exit 2
    ;;
esac
