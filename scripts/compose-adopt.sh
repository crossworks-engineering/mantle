#!/bin/sh
#
# One-time adoption of the release-owned compose contract on an EXISTING box.
#
# Boxes installed before v0.142 have no `docker-compose.yml.release` baseline,
# so the updater sidecar cannot prove their compose is pristine and will not
# auto-refresh it (update.log + /settings/updates show "no-baseline"). This
# script closes that gap, run FROM THE STACK DIR (~/mantle):
#
#   sh scripts/compose-adopt.sh            # show the diff, change nothing
#   sh scripts/compose-adopt.sh --apply    # install canonical + baseline
#
# It extracts the canonical docker-compose.yml embedded in the image this box
# is configured for (.env MANTLE_IMAGE_NAMESPACE/mantle:MANTLE_IMAGE_TAG),
# diffs it against the box's file, and with --apply: saves the current file to
# docker-compose.yml.pre-adopt.<utc-ts>, installs the canonical as
# docker-compose.yml AND as the .release baseline. From then on the updater
# refreshes compose automatically on every update.
#
# BEFORE --apply, move any box-local customization the diff shows into
# docker-compose.override.yml (compose merges it automatically — verify the
# merged result with `docker compose config`) or .env. After --apply, converge
# with: docker compose up -d --remove-orphans
#
# Images older than v0.142 ship no embedded canonical — update the box once
# (tag-only) first, then adopt.

set -eu

STACK="${1:-}"
case "$STACK" in --apply|'') STACK=. ;; esac
APPLY=""
for a in "$@"; do [ "$a" = "--apply" ] && APPLY=1; done

[ -f "$STACK/docker-compose.yml" ] || {
  echo "✘ no docker-compose.yml here — run from the stack dir (e.g. ~/mantle)" >&2
  exit 1
}

NS=$(sed -n 's/^MANTLE_IMAGE_NAMESPACE=//p' "$STACK/.env" 2>/dev/null | head -1)
TAG=$(sed -n 's/^MANTLE_IMAGE_TAG=//p' "$STACK/.env" 2>/dev/null | head -1)
IMG="${NS:-titanwest}/mantle:${TAG:-latest}"

echo "▶ extracting canonical docker-compose.yml from $IMG"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CID=$(docker create "$IMG")
docker cp "$CID:/app/release/docker-compose.yml" "$TMP/canonical.yml" 2>/dev/null || true
docker rm "$CID" >/dev/null
[ -s "$TMP/canonical.yml" ] || {
  echo "✘ $IMG ships no embedded canonical (image is older than v0.142)" >&2
  echo "  update the box to a newer tag first, then re-run this script" >&2
  exit 1
}

if cmp -s "$STACK/docker-compose.yml" "$TMP/canonical.yml"; then
  echo "✔ box compose already matches the canonical"
else
  echo "── diff: box docker-compose.yml → canonical ─────────────────────────"
  diff -u "$STACK/docker-compose.yml" "$TMP/canonical.yml" || true
  echo "─────────────────────────────────────────────────────────────────────"
  echo "  lines the box ADDS (left-only, '-') are local edits: port them to"
  echo "  docker-compose.override.yml + .env BEFORE applying, or they are lost."
fi

if [ -z "$APPLY" ]; then
  echo "▶ dry run — re-run with --apply to install canonical + baseline"
  exit 0
fi

TS=$(date -u +%Y%m%d-%H%M%S)
cp "$STACK/docker-compose.yml" "$STACK/docker-compose.yml.pre-adopt.$TS"
cp "$TMP/canonical.yml" "$STACK/docker-compose.yml.release.tmp"
mv "$STACK/docker-compose.yml.release.tmp" "$STACK/docker-compose.yml.release"
cp "$TMP/canonical.yml" "$STACK/docker-compose.yml.tmp"
mv "$STACK/docker-compose.yml.tmp" "$STACK/docker-compose.yml"
echo "✔ canonical installed (previous file: docker-compose.yml.pre-adopt.$TS)"
echo "  converge with: docker compose up -d --remove-orphans"
