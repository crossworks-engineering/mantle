#!/usr/bin/env bash
# (Re)publish a remote Mantle's DATA PLANE — Postgres + MinIO — on the tailnet
# via `tailscale serve --tcp` on the remote node, so devices on your tailnet can
# reach them by MagicDNS (e.g. mantle.taildc9091.ts.net:5432) with no SSH tunnel.
# See docs/remote-db-dev.md.
#
# `tailscale serve` targets must be IPs, and docker container IPs change when a
# container is recreated — so this re-resolves them every run. Run `up` again
# after a prod redeploy if the tailnet DB/S3 endpoints stop responding.
#
# ⚠️ This is a STANDING exposure: the DB + object store become reachable to every
# device on your tailnet (scope with tailnet ACLs). `reset` removes it.
#
# Usage:  scripts/prod-tailscale-serve.sh [up|status|reset]      (default: up)
#
# Config (env overrides — defaults match the reference deployment):
#   PROD_SSH_HOST           SSH host/alias            (default: mantle-prod)
#   MANTLE_TS_CONTAINER     Tailscale container       (default: mantle_tailscale)
#   MANTLE_PG_CONTAINER     Postgres container        (default: mantle_pg)
#   MANTLE_MINIO_CONTAINER  MinIO container           (default: mantle_minio)
set -euo pipefail

PROD_SSH_HOST="${PROD_SSH_HOST:-mantle-prod}"
TS="${MANTLE_TS_CONTAINER:-mantle_tailscale}"
PG="${MANTLE_PG_CONTAINER:-mantle_pg}"
MINIO="${MANTLE_MINIO_CONTAINER:-mantle_minio}"
ACTION="${1:-up}"

ip_of='docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"'

case "$ACTION" in
  up)
    ssh -o ConnectTimeout=20 "$PROD_SSH_HOST" "
      set -e
      PG_IP=\$($ip_of $PG)
      MINIO_IP=\$($ip_of $MINIO)
      echo \"resolved: pg=\$PG_IP minio=\$MINIO_IP\"
      docker exec $TS tailscale serve --bg --tcp 5432 tcp://\$PG_IP:5432
      docker exec $TS tailscale serve --bg --tcp 9000 tcp://\$MINIO_IP:9000
      echo '--- serve status ---'
      docker exec $TS tailscale serve status
    "
    ;;
  status)
    ssh -o ConnectTimeout=20 "$PROD_SSH_HOST" "docker exec $TS tailscale serve status"
    ;;
  reset)
    ssh -o ConnectTimeout=20 "$PROD_SSH_HOST" "
      docker exec $TS tailscale serve --tcp=5432 off || true
      docker exec $TS tailscale serve --tcp=9000 off || true
      echo '--- serve status ---'
      docker exec $TS tailscale serve status
    "
    ;;
  *)
    echo "usage: scripts/prod-tailscale-serve.sh [up|status|reset]" >&2
    exit 2
    ;;
esac
