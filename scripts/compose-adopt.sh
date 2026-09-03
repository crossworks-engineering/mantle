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
IMG="${NS:-titanwest}/mantle-server:${TAG:-latest}"

echo "▶ extracting canonical compose files from $IMG"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CID=$(docker create "$IMG")
docker cp "$CID:/app/release/docker-compose.yml" "$TMP/canonical.yml" 2>/dev/null || true
# v0.200+ also ships the client-stack compose; older images simply don't have it.
docker cp "$CID:/app/release/docker-compose.client.yml" "$TMP/canonical.client.yml" 2>/dev/null || true
# v0.231+ ships the brain-core override too (docker-compose.core.yml).
docker cp "$CID:/app/release/docker-compose.core.yml" "$TMP/canonical.core.yml" 2>/dev/null || true
docker cp "$CID:/app/release/Caddyfile" "$TMP/Caddyfile" 2>/dev/null || true
mkdir -p "$TMP/shapes"; docker cp "$CID:/app/release/caddy-shapes/." "$TMP/shapes" 2>/dev/null || true
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
# Client compose (v0.200+): adopt/baseline it too when the image ships one AND
# the box runs (or is adopting) the client stack — presence of either the box
# file or the canonical means it applies here.
if [ -s "$TMP/canonical.client.yml" ]; then
  if [ -f "$STACK/docker-compose.client.yml" ]; then
    cp "$STACK/docker-compose.client.yml" "$STACK/docker-compose.client.yml.pre-adopt.$TS"
  fi
  cp "$TMP/canonical.client.yml" "$STACK/docker-compose.client.yml.release.tmp"
  mv "$STACK/docker-compose.client.yml.release.tmp" "$STACK/docker-compose.client.yml.release"
  cp "$TMP/canonical.client.yml" "$STACK/docker-compose.client.yml.tmp"
  mv "$STACK/docker-compose.client.yml.tmp" "$STACK/docker-compose.client.yml"
  echo "✔ client compose canonical installed"
fi
# Core override (v0.231+): adopt/baseline it whenever the image ships one. It
# is inert unless .env COMPOSE_FILE names it, so installing it on a full box
# costs nothing and lets `install.sh --core` work later without a re-download.
if [ -s "$TMP/canonical.core.yml" ]; then
  if [ -f "$STACK/docker-compose.core.yml" ]; then
    cp "$STACK/docker-compose.core.yml" "$STACK/docker-compose.core.yml.pre-adopt.$TS"
  fi
  cp "$TMP/canonical.core.yml" "$STACK/docker-compose.core.yml.release.tmp"
  mv "$STACK/docker-compose.core.yml.release.tmp" "$STACK/docker-compose.core.yml.release"
  cp "$TMP/canonical.core.yml" "$STACK/docker-compose.core.yml.tmp"
  mv "$STACK/docker-compose.core.yml.tmp" "$STACK/docker-compose.core.yml"
  echo "✔ core compose override installed"
fi
# Front door (v0.232.126+): the Caddyfile and its shapes are release-owned
# like compose. Seed the baselines so the updater can refresh them from the
# next roll on; a box's own routes belong in infra/caddy/conf.d/ (untouched).
#
# ORDER MATTERS: shapes first, Caddyfile last, and nothing at all unless the
# shapes folder is writable. The Caddyfile imports the shape by name, so a
# Caddyfile installed without its shape crash-loops caddy and takes the site
# down (dev, 2026-09-02: the roll had created infra/caddy/shapes root-owned
# as a bind-mount side effect, an unprivileged adopt wrote the Caddyfile,
# then failed on the shape). Refuse loudly instead.
if [ -s "$TMP/Caddyfile" ]; then
  mkdir -p "$STACK/infra/caddy/shapes" "$STACK/infra/caddy/conf.d" 2>/dev/null || true
  if [ ! -w "$STACK/infra/caddy/shapes" ] || [ ! -w "$STACK/infra/caddy" ]; then
    echo "✘ infra/caddy or infra/caddy/shapes is not writable by $(id -un)." >&2
    echo "  Re-run with sudo (the folder is usually root-owned after a roll created it)." >&2
    echo "  The Caddyfile was NOT touched: an unsatisfied shape import would crash-loop caddy." >&2
    exit 1
  fi
  shapes_ok=1
  for f in "$TMP"/shapes/*.caddy; do
    [ -f "$f" ] || { shapes_ok=0; break; }
    b=$(basename "$f")
    cp "$f" "$STACK/infra/caddy/shapes/$b.release" && cp "$f" "$STACK/infra/caddy/shapes/$b" || shapes_ok=0
  done
  if [ "$shapes_ok" != 1 ] || [ ! -s "$STACK/infra/caddy/shapes/same-origin.caddy" ]; then
    echo "✘ could not install the routing shapes; leaving the Caddyfile as it is." >&2
    exit 1
  fi
  if [ -f "$STACK/infra/caddy/Caddyfile" ] && ! cmp -s "$STACK/infra/caddy/Caddyfile" "$TMP/Caddyfile"; then
    cp "$STACK/infra/caddy/Caddyfile" "$STACK/infra/caddy/Caddyfile.pre-adopt.$TS"
    echo "  (previous Caddyfile kept as infra/caddy/Caddyfile.pre-adopt.$TS; box routes go in conf.d/)"
  fi
  cp "$TMP/Caddyfile" "$STACK/infra/caddy/Caddyfile.release"
  cp "$TMP/Caddyfile" "$STACK/infra/caddy/Caddyfile"
  echo "✔ shapes + Caddyfile canonical installed (baselines seeded)"
  # The release Caddyfile routes by MANTLE_CADDY_SHAPE and silently defaults
  # to same-origin. Right for a one-domain box, wrong for one that serves the
  # owner UI on its own hostname: say which one this box just got.
  shape=$(sed -n 's/^MANTLE_CADDY_SHAPE=//p' "$STACK/.env" 2>/dev/null | head -1)
  if [ -n "$shape" ]; then
    echo "  front door shape: $shape (MANTLE_CADDY_SHAPE in .env)"
  else
    echo "  front door shape: same-origin (MANTLE_CADDY_SHAPE is not set in .env, so the default applies:"
    echo "  one domain routes both apps; set MANTLE_CADDY_SHAPE=split for the owner UI on its own hostname)"
  fi
  echo "  recreate the front door: docker compose up -d --no-deps --force-recreate caddy"
fi
echo "  converge with: docker compose up -d --remove-orphans"
echo "  (client stack: docker compose -f docker-compose.client.yml --project-directory . up -d)"
