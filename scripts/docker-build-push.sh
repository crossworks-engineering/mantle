#!/usr/bin/env bash
# Build the Mantle images and push them to Docker Hub.
#
# Every runtime service (web, agent, the workers, migrate) is the SAME
# server image — they differ only in the compose `command:` — built via the
# `web` service. The media sidecar (`infra/media-sidecar`, compose profile
# `media`) is a second, tiny image built from the root Dockerfile's `media`
# stage. The base-image services (postgres/minio/tika/browser/ollama/
# tailscale/caddy) are NOT ours and are not pushed.
#
# Usage:
#   docker login
#   MANTLE_IMAGE_NAMESPACE=youruser [MANTLE_IMAGE_TAG=v1] scripts/docker-build-push.sh
#
# Pushes:  <namespace>/mantle-server:<tag>  and  <namespace>/mantle-media:<tag>
set -euo pipefail
cd "$(dirname "$0")/.."

: "${MANTLE_IMAGE_NAMESPACE:?set MANTLE_IMAGE_NAMESPACE to your Docker Hub user/org (e.g. export MANTLE_IMAGE_NAMESPACE=titanwest)}"
TAG="${MANTLE_IMAGE_TAG:-latest}"

# compose interpolates the whole file (incl. the `${VAR:?}` runtime guards) even
# for `build`, so supply throwaway values — they're never baked into the image.
export SESSION_SECRET="${SESSION_SECRET:-build}"
export MANTLE_MASTER_KEY="${MANTLE_MASTER_KEY:-build}"
export ALLOWED_USER_ID="${ALLOWED_USER_ID:-00000000-0000-0000-0000-000000000000}"
export MANTLE_IMAGE_TAG="$TAG"

# Build identity — baked into the image (MANTLE_GIT_SHA/MANTLE_BUILD_TIME env; the server resolves them at boot) and
# shown next to the wordmark + at /api/version. `.git` isn't in the build
# context, so we resolve the SHA here and hand it to the build as an arg.
export MANTLE_GIT_SHA="${MANTLE_GIT_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo '')}"
export MANTLE_BUILD_TIME="${MANTLE_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

echo "▶ Building ${MANTLE_IMAGE_NAMESPACE}/mantle-server:${TAG}  (sha ${MANTLE_GIT_SHA:-none}, ${MANTLE_BUILD_TIME})"
docker compose build web

echo "▶ Building ${MANTLE_IMAGE_NAMESPACE}/mantle-media:${TAG}"
docker build --target media -t "${MANTLE_IMAGE_NAMESPACE}/mantle-media:${TAG}" .

echo "▶ Pushing to Docker Hub"
docker compose push web
docker push "${MANTLE_IMAGE_NAMESPACE}/mantle-media:${TAG}"

echo "✔ Pushed ${MANTLE_IMAGE_NAMESPACE}/mantle-server:${TAG} + mantle-media:${TAG}"
echo "  On the VPS:  MANTLE_IMAGE_NAMESPACE=${MANTLE_IMAGE_NAMESPACE} MANTLE_IMAGE_TAG=${TAG} docker compose pull && docker compose up -d --wait"
