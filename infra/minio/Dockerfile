# syntax=docker/dockerfile:1
#
# Our own MinIO image, built from MinIO's public AGPL source at the exact
# releases the stack has always pinned. Published as
# <namespace>/mantle-minio:<MINIO_TAG> by .github/workflows/minio-image.yml.
#
# Why this exists: MinIO left open source in steps. The community repo was
# archived in 2026-04, minio/minio and minio/mc vanished from Docker Hub about
# 2026-09-11, and the quay.io copies started answering 401 soon after, so
# every updater roll and every fresh install failed at `compose pull`. The only
# image MinIO still publishes (quay.io/minio/aistor/minio) is the commercial
# AIStor build, which denies every S3 call until a licence is installed.
#
# Same layout as the upstream image this replaces: minio AND mc in /usr/bin
# (the compose healthcheck runs `mc ready local`), upstream's
# docker-entrypoint.sh, the ubi9-micro base,
# /data as the volume. Source: https://github.com/minio/minio (tag
# $MINIO_TAG) and https://github.com/minio/mc (tag $MC_TAG), AGPL-3.0.
#
# Stopgap: the long-term plan replaces MinIO with an S3-compatible store that
# is still maintained. Until then, this pins the last community release.

ARG MINIO_TAG=RELEASE.2025-09-07T16-13-09Z
ARG MC_TAG=RELEASE.2025-08-13T08-35-41Z

# Cross-compile on the build platform (Go needs no emulation for arm64).
FROM --platform=$BUILDPLATFORM golang:1.24-bookworm AS build
ARG MINIO_TAG
ARG MC_TAG
ARG TARGETOS
ARG TARGETARCH
# go.mod asks for a newer toolchain patch than the image may carry.
ENV GOTOOLCHAIN=auto CGO_ENABLED=0
WORKDIR /src
RUN git clone --depth 1 --branch "$MINIO_TAG" https://github.com/minio/minio.git minio \
 && git clone --depth 1 --branch "$MC_TAG" https://github.com/minio/mc.git mc

# release_time RELEASE.2025-09-07T16-13-09Z -> 2025-09-07T16:13:09Z, the
# version argument upstream's gen-ldflags.go turns back into the release tag
# (so `minio --version` reports the same release as the official binary).
# MINIO_RELEASE / MC_RELEASE=RELEASE is the prefix upstream's release build
# passes (unset, the tag reads DEVELOPMENT.*). gen-ldflags runs on the build
# platform, so GOOS/GOARCH are set only for the real build.
RUN release_time() { echo "$1" | sed -E 's/^RELEASE\.([0-9-]+)T([0-9]+)-([0-9]+)-([0-9]+)Z$/\1T\2:\3:\4Z/'; } \
 && mkdir -p /out \
 && cd /src/minio \
 && LDFLAGS="$(MINIO_RELEASE=RELEASE go run buildscripts/gen-ldflags.go "$(release_time "$MINIO_TAG")")" \
 && GOOS=$TARGETOS GOARCH=$TARGETARCH go build -tags kqueue -trimpath -ldflags "$LDFLAGS" -o /out/minio \
 && cd /src/mc \
 && LDFLAGS="$(MC_RELEASE=RELEASE go run buildscripts/gen-ldflags.go "$(release_time "$MC_TAG")")" \
 && GOOS=$TARGETOS GOARCH=$TARGETARCH go build -tags kqueue -trimpath -ldflags "$LDFLAGS" -o /out/mc

FROM registry.access.redhat.com/ubi9/ubi-micro:latest
ARG MINIO_TAG
ARG MC_TAG

LABEL name="mantle-minio" \
      version="$MINIO_TAG" \
      release="$MINIO_TAG" \
      summary="MinIO $MINIO_TAG + mc $MC_TAG, built from upstream AGPL source" \
      org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

# Upstream's image environment, verbatim, so behaviour matches the image the
# fleet ran before.
ENV MINIO_ACCESS_KEY_FILE=access_key \
    MINIO_SECRET_KEY_FILE=secret_key \
    MINIO_ROOT_USER_FILE=access_key \
    MINIO_ROOT_PASSWORD_FILE=secret_key \
    MINIO_KMS_SECRET_KEY_FILE=kms_master_key \
    MINIO_UPDATE_MINISIGN_PUBKEY=RWTx5Zr1tiHQLwG9keckT0c45M3AGeHD6IvimQHpyRywVWGbP1aVSGav \
    MINIO_CONFIG_ENV_FILE=config.env \
    MC_CONFIG_DIR=/tmp/.mc

COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build --chmod=755 /out/minio /out/mc /usr/bin/
COPY --from=build --chmod=755 /src/minio/dockerscripts/docker-entrypoint.sh /usr/bin/docker-entrypoint.sh
COPY --from=build /src/minio/LICENSE /src/minio/CREDITS /licenses/

EXPOSE 9000
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/docker-entrypoint.sh"]
CMD ["minio"]
