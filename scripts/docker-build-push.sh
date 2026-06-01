#!/usr/bin/env bash
# Build all Mantle images and push them to Docker Hub.
#
# Run this on your build machine (local), then `docker compose pull` on the VPS.
# The base-image services (postgres/minio/tika/ollama/tailscale) are NOT pushed —
# only the seven we build from the Dockerfile.
#
# Usage:
#   docker login
#   MANTLE_IMAGE_NAMESPACE=youruser [MANTLE_IMAGE_TAG=v1] scripts/docker-build-push.sh
#
# Pushes:  <namespace>/mantle-{migrate,web,agent,worker-email,worker-telegram,worker-files,worker-events}:<tag>
set -euo pipefail
cd "$(dirname "$0")/.."

: "${MANTLE_IMAGE_NAMESPACE:?set MANTLE_IMAGE_NAMESPACE to your Docker Hub user/org (e.g. export MANTLE_IMAGE_NAMESPACE=jschoeman)}"
TAG="${MANTLE_IMAGE_TAG:-latest}"

# compose interpolates the whole file (incl. the `${VAR:?}` runtime guards) even
# for `build`, so supply throwaway values — they're never baked into the image.
export SESSION_SECRET="${SESSION_SECRET:-build}"
export MANTLE_MASTER_KEY="${MANTLE_MASTER_KEY:-build}"
export ALLOWED_USER_ID="${ALLOWED_USER_ID:-00000000-0000-0000-0000-000000000000}"
export MANTLE_IMAGE_TAG="$TAG"

BUILT=(migrate web agent worker_email worker_telegram worker_files worker_events)

echo "▶ Building ${MANTLE_IMAGE_NAMESPACE}/mantle-*:${TAG}"
docker compose build "${BUILT[@]}"

echo "▶ Pushing to Docker Hub"
docker compose push "${BUILT[@]}"

echo "✔ Pushed ${MANTLE_IMAGE_NAMESPACE}/mantle-*:${TAG}"
echo "  On the VPS:  MANTLE_IMAGE_NAMESPACE=${MANTLE_IMAGE_NAMESPACE} MANTLE_IMAGE_TAG=${TAG} docker compose pull && docker compose up -d --wait"
