#!/usr/bin/env bash
#
# Behavioural tests for the deploy shell: the root install.sh bootstrap and
# infra/updater/updater.sh, run against a FAKE stack with a stubbed docker.
# No daemon, no network, no box. Run by hand from anywhere in the repo:
#
#   bash scripts/test-deploy-scripts.sh
#   TEST_SH=dash bash scripts/test-deploy-scripts.sh   # closer to busybox ash
#
# Not wired into `pnpm verify`: the vitest suite (server/web/lib/*.test.ts)
# lifts single functions out of updater.sh and pins its literals; this
# exercises whole flows and needs a shell, not node. A one-file vitest wrapper
# that execFileSyncs this script would wire it in.
#
# What is covered, and the finding behind each:
#   install: a bundle install seeds every .release baseline; the raw-fetch
#            path creates infra/caddy/{shapes,conf.d} before curl writes there
#   env:     .env rewrites keep the operator's owner and mode (0600 stays 0600)
#   compose: a .env that cannot satisfy the incoming `${VAR:?}` compose
#            refuses the swap, keeps the old file, and names the variables
#   caddy:   shapes are installed before the Caddyfile; a shape change forces
#            the caddy recreate even when the Caddyfile itself is modified
#   scripts: .pre-adopt backups are pruned to the newest three per script
#   pull:    install.sh retries a failed image pull with backoff, and never
#            runs `up` on a partial pull; the client step checks the server
#            network exists before joining it
#   sanity:  Caddy's own HTTP->HTTPS redirect is not reported as "not Mantle"

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SH=${TEST_SH:-sh}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0

ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$*" >&2; }
check() { # <description> <command...>: pass when the command succeeds
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$d"; else fail "$d"; fi
}
same() { cmp -s "$1" "$2"; }
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
owner_of() { stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1"; }

# ── the docker stub ──────────────────────────────────────────────────────────
# A shell function the sourced updater calls instead of the CLI. `create`
# returns a fake id, `cp` copies out of $FAKE_IMG (the image's /app/release),
# and `compose ... config -q` does what compose does with `${VAR:?}`: fails
# naming the first variable the --env-file cannot supply.
DOCKER_STUB='
docker() {
  case "$1" in
    create) echo fakecid; return 0 ;;
    rm|pull) return 0 ;;
    cp)
      src=${2#*:}; src=${src#/app/release/}
      if [ -d "$FAKE_IMG/$src" ]; then cp -R "$FAKE_IMG/$src" "$3"
      elif [ -f "$FAKE_IMG/$src" ]; then cp "$FAKE_IMG/$src" "$3"
      else echo "stub: no $src in fake image" >&2; return 1; fi
      return 0 ;;
    compose)
      shift; envf=""; files=""
      while [ $# -gt 0 ]; do
        case "$1" in
          -f) files="$files $2"; shift 2 ;;
          --env-file) envf=$2; shift 2 ;;
          --project-directory) shift 2 ;;
          config)
            for f in $files; do
              for v in $(sed -n "s/.*\${\([A-Za-z_][A-Za-z0-9_]*\):?.*/\1/p" "$f"); do
                grep -q "^$v=." "$envf" 2>/dev/null \
                  || { echo "required variable $v is missing a value: set it in .env" >&2; return 1; }
              done
            done
            return 0 ;;
          *) shift ;;
        esac
      done
      return 0 ;;
  esac
  return 0
}
'

# updater_run <stack> <sig> <fake-image> <body>: source updater.sh in library
# mode under $SH with the stub in place, then run <body> in that shell.
updater_run() {
  MANTLE_STACK_DIR="$1" MANTLE_SIGNAL_DIR="$2" FAKE_IMG="$3" MANTLE_UPDATER_LIB=1 \
    "$SH" -c "$DOCKER_STUB
. '$ROOT/infra/updater/updater.sh'
$4"
}

# fake_stack <dir>: a minimal pristine stack (compose + baseline, .env, sig).
fake_stack() {
  mkdir -p "$1/stack/infra/caddy/shapes" "$1/stack/scripts" "$1/sig" "$1/img/caddy-shapes" "$1/img/scripts"
  printf 'services: {web: {image: old}}\n' > "$1/stack/docker-compose.yml"
  cp "$1/stack/docker-compose.yml" "$1/stack/docker-compose.yml.release"
  printf 'MANTLE_IMAGE_NAMESPACE=test\nMANTLE_MASTER_KEY=k\nSESSION_SECRET=s\n' > "$1/stack/.env"
  chmod 600 "$1/stack/.env"
  : > "$1/sig/update.log"
}

# ═════════════════════════════════════════════════════════════════════════════
echo "install.sh: baselines on both fetch paths"
# A fake `docker` on PATH satisfies the prerequisite checks; the bundle's
# scripts/install.sh is replaced by a stub so the bootstrap's own work (fetch,
# unpack, seed) is what gets tested, hermetically.
mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexit 0\n' > "$WORK/bin/docker"; chmod +x "$WORK/bin/docker"
SCRIPTS='db-dump.sh db-restore.sh install.sh sanity.sh compose-adopt.sh uninstall.sh'
RELEASE_FILES='docker-compose.yml docker-compose.client.yml docker-compose.core.yml infra/caddy/Caddyfile infra/caddy/shapes/same-origin.caddy infra/caddy/shapes/split.caddy'

# The tree both paths serve: the worktree's real files, one stub.
TREE="$WORK/tree/mantle-deploy"
mkdir -p "$TREE/scripts"
cp "$ROOT"/docker-compose.yml "$ROOT"/docker-compose.client.yml "$ROOT"/docker-compose.core.yml "$ROOT"/.env.prod.example "$ROOT"/install.sh "$TREE/"
cp -R "$ROOT/infra" "$TREE/infra"
for s in $SCRIPTS; do cp "$ROOT/scripts/$s" "$TREE/scripts/$s"; done
printf '#!/bin/sh\necho "stub configurator: $*"\n' > "$TREE/scripts/install.sh"

assert_seeded() { # <home> <label>
  local home="$1" label="$2" f
  for f in $RELEASE_FILES; do
    check "$label: $f.release seeded and identical" same "$home/$f" "$home/$f.release"
  done
  for f in $SCRIPTS; do
    check "$label: scripts/$f.release seeded and identical" same "$home/scripts/$f" "$home/scripts/$f.release"
  done
  check "$label: infra/caddy/conf.d exists" test -d "$home/infra/caddy/conf.d"
  check "$label: infra/caddy/shapes exists" test -d "$home/infra/caddy/shapes"
}

# bundle path: a release tarball + SHA256SUMS served over file://
TAG=v9.9.9-test
REL="$WORK/releases/download/$TAG"; mkdir -p "$REL"
tar -C "$WORK/tree" -czf "$REL/mantle-deploy-$TAG.tar.gz" mantle-deploy
if command -v sha256sum >/dev/null 2>&1; then (cd "$REL" && sha256sum "mantle-deploy-$TAG.tar.gz" > SHA256SUMS)
else (cd "$REL" && shasum -a 256 "mantle-deploy-$TAG.tar.gz" > SHA256SUMS); fi
if PATH="$WORK/bin:$PATH" MANTLE_REPO_RELEASES="file://$WORK/releases" MANTLE_CHANNEL="$TAG" \
   MANTLE_HOME="$WORK/home-bundle" MANTLE_YES=1 MANTLE_SKIP_START=1 \
   bash "$ROOT/install.sh" > "$WORK/install-bundle.log" 2>&1; then
  ok "bundle install ran to completion"
else
  fail "bundle install exited non-zero (see below)"; sed 's/^/    /' "$WORK/install-bundle.log"
fi
assert_seeded "$WORK/home-bundle" "bundle"

# raw path (MANTLE_CHANNEL=main, also the fallback when the release lookup
# fails): file-by-file fetch into a tree that must already have its dirs.
RAW="$WORK/raw/main"; mkdir -p "$RAW"
cp -R "$TREE/." "$RAW/"
if PATH="$WORK/bin:$PATH" MANTLE_REPO_RAW="file://$WORK/raw" MANTLE_CHANNEL=main \
   MANTLE_HOME="$WORK/home-raw" MANTLE_YES=1 MANTLE_SKIP_START=1 \
   bash "$ROOT/install.sh" > "$WORK/install-raw.log" 2>&1; then
  ok "raw fetch install ran to completion (shapes dir existed before curl -o)"
else
  fail "raw fetch install exited non-zero (see below)"; sed 's/^/    /' "$WORK/install-raw.log"
fi
assert_seeded "$WORK/home-raw" "raw"

# ═════════════════════════════════════════════════════════════════════════════
echo "updater.sh: .env keeps owner and mode"
T="$WORK/env"; fake_stack "$T"
printf 'MANTLE_CLIENT_IMAGE_TAG=v0\nMANTLE_IMAGE_NAMESPACE=test\n' > "$T/stack/.env"; chmod 600 "$T/stack/.env"
before_owner=$(owner_of "$T/stack/.env")
( umask 022; updater_run "$T/stack" "$T/sig" "$T/img" 'persist_env MANTLE_CLIENT_IMAGE_TAG v1' )
check "rewrite: value updated" grep -qx 'MANTLE_CLIENT_IMAGE_TAG=v1' "$T/stack/.env"
check "rewrite: other lines intact" grep -qx 'MANTLE_IMAGE_NAMESPACE=test' "$T/stack/.env"
check "rewrite: mode stays 600" test "$(mode_of "$T/stack/.env")" = 600
check "rewrite: owner unchanged" test "$(owner_of "$T/stack/.env")" = "$before_owner"
check "rewrite: no temp file left" test ! -e "$T/stack/.env.updater-tmp"
( umask 022; updater_run "$T/stack" "$T/sig" "$T/img" 'persist_env MANTLE_NEW_VAR x' )
check "append: value added" grep -qx 'MANTLE_NEW_VAR=x' "$T/stack/.env"
check "append: mode stays 600" test "$(mode_of "$T/stack/.env")" = 600
chmod 640 "$T/stack/.env"
( umask 022; updater_run "$T/stack" "$T/sig" "$T/img" 'persist_env MANTLE_CLIENT_IMAGE_TAG v2' )
check "rewrite: an operator-chosen 640 is preserved" test "$(mode_of "$T/stack/.env")" = 640
# the MANTLE_IMAGE_TAG write in the roll goes through the same path
chmod 600 "$T/stack/.env"
( umask 022; updater_run "$T/stack" "$T/sig" "$T/img" 'persist_env MANTLE_IMAGE_TAG v3' )
check "image tag: written" grep -qx 'MANTLE_IMAGE_TAG=v3' "$T/stack/.env"
check "image tag: mode stays 600" test "$(mode_of "$T/stack/.env")" = 600

# ═════════════════════════════════════════════════════════════════════════════
echo "updater.sh: a .env that cannot satisfy the incoming compose refuses the swap"
T="$WORK/compose"; fake_stack "$T"
cat > "$T/img/docker-compose.yml" <<'YML'
services:
  postgres: {environment: {POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?set it in .env}"}}
  objectstore: {environment: {S3_ACCESS_KEY: "${S3_ACCESS_KEY:?set it}", S3_SECRET_KEY: "${S3_SECRET_KEY:?set it}"}}
  web: {environment: {SESSION_SECRET: "${SESSION_SECRET:?required}", MANTLE_MASTER_KEY: "${MANTLE_MASTER_KEY:?required}"}}
YML
printf 'MANTLE_IMAGE_NAMESPACE=test\nMANTLE_MASTER_KEY=k\nSESSION_SECRET=s\nS3_ACCESS_KEY=minio\n' > "$T/stack/.env"
out=$(updater_run "$T/stack" "$T/sig" "$T/img" 'refresh_compose v1 >/dev/null; echo "REFRESH=$REFRESH"')
check "outcome is incompatible-env" test "$out" = "REFRESH=incompatible-env"
check "box compose untouched" same "$T/stack/docker-compose.yml" "$T/stack/docker-compose.yml.release"
check "box compose still the old one" grep -q 'image: old' "$T/stack/docker-compose.yml"
check "no .prev written (nothing was swapped)" test ! -e "$T/stack/docker-compose.yml.prev"
check "no incoming temp left" test ! -e "$T/stack/.compose-incoming.tmp"
check "log names POSTGRES_PASSWORD as missing" grep -q 'Missing from .env:.*POSTGRES_PASSWORD' "$T/sig/update.log"
check "log names S3_SECRET_KEY as missing" grep -q 'Missing from .env:.*S3_SECRET_KEY' "$T/sig/update.log"
check "log does NOT list the S3_ACCESS_KEY the box has" sh -c "! grep -q 'Missing from .env:.*S3_ACCESS_KEY' '$T/sig/update.log'"
check "log gives the POSTGRES_PASSWORD line to add" grep -qx '    POSTGRES_PASSWORD=postgres' "$T/sig/update.log"
check "log gives the S3_SECRET_KEY line to add" grep -qx '    S3_SECRET_KEY=minio12345' "$T/sig/update.log"
check "log says to continue on the existing compose" grep -q 'Continuing on the EXISTING compose' "$T/sig/update.log"
# operator adds the lines, next request lands the swap
printf 'POSTGRES_PASSWORD=postgres\nS3_SECRET_KEY=minio12345\n' >> "$T/stack/.env"
out=$(updater_run "$T/stack" "$T/sig" "$T/img" 'refresh_compose v1 >/dev/null; echo "REFRESH=$REFRESH"')
check "after fixing .env the compose refreshes" test "$out" = "REFRESH=refreshed"
check "live compose is the canonical" same "$T/stack/docker-compose.yml" "$T/img/docker-compose.yml"
check "baseline follows" same "$T/stack/docker-compose.yml.release" "$T/img/docker-compose.yml"
check ".prev holds the old compose" grep -q 'image: old' "$T/stack/docker-compose.yml.prev"
# a hand-edited compose is still reported as modified, not as incompatible
printf '# local edit\n' >> "$T/stack/docker-compose.yml"
printf 'services: {web: {image: newer}}\n' > "$T/img/docker-compose.yml"
out=$(updater_run "$T/stack" "$T/sig" "$T/img" 'refresh_compose v2 >/dev/null; echo "REFRESH=$REFRESH"')
check "modified compose still reads modified" test "$out" = "REFRESH=modified"

# ═════════════════════════════════════════════════════════════════════════════
echo "updater.sh: caddy shapes first; recreate forced on ANY front-door change"
caddy_case() { # <name>: a fresh stack + image with pristine Caddyfile and shapes
  T="$WORK/caddy-$1"; fake_stack "$T"
  printf 'old caddyfile\n' > "$T/stack/infra/caddy/Caddyfile"; cp "$T/stack/infra/caddy/Caddyfile" "$T/stack/infra/caddy/Caddyfile.release"
  for s in same-origin split; do
    printf 'old %s\n' "$s" > "$T/stack/infra/caddy/shapes/$s.caddy"; cp "$T/stack/infra/caddy/shapes/$s.caddy" "$T/stack/infra/caddy/shapes/$s.caddy.release"
    cp "$T/stack/infra/caddy/shapes/$s.caddy" "$T/img/caddy-shapes/$s.caddy"
  done
  cp "$T/stack/infra/caddy/Caddyfile" "$T/img/Caddyfile"
}
caddy_probe='IMG=test/mantle-server:v1; refresh_caddy v1 >/dev/null; echo "CADDY_REFRESH=$CADDY_REFRESH CADDY_RECREATE=$CADDY_RECREATE"'

caddy_case current
out=$(updater_run "$T/stack" "$T/sig" "$T/img" "$caddy_probe")
check "nothing changed: current, no recreate" test "$out" = "CADDY_REFRESH=current CADDY_RECREATE="

caddy_case shape-only
printf 'new same-origin\n' > "$T/img/caddy-shapes/same-origin.caddy"
out=$(updater_run "$T/stack" "$T/sig" "$T/img" "$caddy_probe")
check "shape changed, Caddyfile current: reads refreshed, recreate forced" test "$out" = "CADDY_REFRESH=refreshed CADDY_RECREATE=1"
check "shape installed" same "$T/stack/infra/caddy/shapes/same-origin.caddy" "$T/img/caddy-shapes/same-origin.caddy"

caddy_case modified-caddyfile
printf 'hand edited\n' >> "$T/stack/infra/caddy/Caddyfile"
printf 'new same-origin\n' > "$T/img/caddy-shapes/same-origin.caddy"
out=$(updater_run "$T/stack" "$T/sig" "$T/img" "$caddy_probe")
check "shape changed under a MODIFIED Caddyfile: modified, recreate STILL forced" test "$out" = "CADDY_REFRESH=modified CADDY_RECREATE=1"
check "modified Caddyfile untouched" grep -q 'hand edited' "$T/stack/infra/caddy/Caddyfile"
check "shape still installed" same "$T/stack/infra/caddy/shapes/same-origin.caddy" "$T/img/caddy-shapes/same-origin.caddy"

caddy_case no-baseline-caddyfile
rm "$T/stack/infra/caddy/Caddyfile.release"; printf 'pre-126 caddyfile\n' > "$T/stack/infra/caddy/Caddyfile"
printf 'new split\n' > "$T/img/caddy-shapes/split.caddy"
out=$(updater_run "$T/stack" "$T/sig" "$T/img" "$caddy_probe")
check "shape changed under a no-baseline Caddyfile: recreate forced" test "$out" = "CADDY_REFRESH=no-baseline CADDY_RECREATE=1"
check "no-baseline message names sudo" grep -q 'sudo sh scripts/compose-adopt.sh --apply' "$T/sig/update.log"
check "no-baseline message names MANTLE_CADDY_SHAPE" grep -q 'MANTLE_CADDY_SHAPE' "$T/sig/update.log"
check "no-baseline message names the caddy recreate" grep -q 'up -d --no-deps --force-recreate caddy' "$T/sig/update.log"

caddy_case caddyfile-only
printf 'new caddyfile\n' > "$T/img/Caddyfile"
out=$(updater_run "$T/stack" "$T/sig" "$T/img" "$caddy_probe")
check "Caddyfile changed, shapes current: refreshed, recreate forced" test "$out" = "CADDY_REFRESH=refreshed CADDY_RECREATE=1"
check "Caddyfile installed" same "$T/stack/infra/caddy/Caddyfile" "$T/img/Caddyfile"

caddy_case ordering
# The image ships a new Caddyfile but NO shapes, and the box has none either
# (adoption impossible): the Caddyfile must NOT be installed.
rm -rf "$T/img/caddy-shapes" "$T/stack/infra/caddy/shapes"/*.caddy*
printf 'new caddyfile importing shapes\n' > "$T/img/Caddyfile"
out=$(updater_run "$T/stack" "$T/sig" "$T/img" "$caddy_probe")
check "missing shapes block the Caddyfile: shape-failed, no recreate" test "$out" = "CADDY_REFRESH=shape-failed CADDY_RECREATE="
check "old Caddyfile still in place" grep -qx 'old caddyfile' "$T/stack/infra/caddy/Caddyfile"
check "log says why" grep -q 'crash-loops caddy' "$T/sig/update.log"

caddy_case adopt-missing-shapes
# pre-126 box: no shape files at all; the image ships them: adopted, and
# the Caddyfile (pristine) refreshes AFTER them.
rm -f "$T/stack/infra/caddy/shapes"/*.caddy*
printf 'new caddyfile\n' > "$T/img/Caddyfile"
out=$(updater_run "$T/stack" "$T/sig" "$T/img" "$caddy_probe")
check "shapes adopted then Caddyfile refreshed" test "$out" = "CADDY_REFRESH=refreshed CADDY_RECREATE=1"
check "same-origin shape adopted with baseline" same "$T/stack/infra/caddy/shapes/same-origin.caddy" "$T/stack/infra/caddy/shapes/same-origin.caddy.release"
check "log order: shape before Caddyfile" sh -c "grep -n 'caddy shape same-origin adopted\|Caddyfile refreshed' '$T/sig/update.log' | head -1 | grep -q 'shape'"

# ═════════════════════════════════════════════════════════════════════════════
echo "updater.sh: .pre-adopt backups pruned to the newest three per script"
T="$WORK/scripts"; fake_stack "$T"
for s in $SCRIPTS; do printf '#!/bin/sh\necho new %s\n' "$s" > "$T/img/scripts/$s"; done
printf '#!/bin/sh\necho old install\n' > "$T/stack/scripts/install.sh"   # no baseline: adopts
for d in 20260101 20260102 20260103 20260104; do : > "$T/stack/scripts/install.sh.pre-adopt.$d-000000"; done
out=$(updater_run "$T/stack" "$T/sig" "$T/img" 'IMG=test/mantle-server:v1; refresh_scripts v1 >/dev/null; echo "SCRIPTS_REFRESH=$SCRIPTS_REFRESH"')
check "scripts refreshed" test "$out" = "SCRIPTS_REFRESH=refreshed"
check "install.sh is the canonical" same "$T/stack/scripts/install.sh" "$T/img/scripts/install.sh"
check "install.sh is executable" test -x "$T/stack/scripts/install.sh"
n=$(ls "$T/stack/scripts"/install.sh.pre-adopt.* | wc -l | tr -d ' ')
check "exactly three backups remain (had 4 + 1 new)" test "$n" = 3
check "the two oldest are gone" sh -c "test ! -e '$T/stack/scripts/install.sh.pre-adopt.20260101-000000' && test ! -e '$T/stack/scripts/install.sh.pre-adopt.20260102-000000'"
check "the newest pre-existing ones survive" sh -c "test -e '$T/stack/scripts/install.sh.pre-adopt.20260103-000000' && test -e '$T/stack/scripts/install.sh.pre-adopt.20260104-000000'"
check "the fresh backup holds the previous copy" sh -c "grep -l 'echo old install' '$T/stack/scripts'/install.sh.pre-adopt.* >/dev/null"
check "other scripts got no backup (they were absent)" sh -c "! ls '$T/stack/scripts'/sanity.sh.pre-adopt.* >/dev/null 2>&1"

# ═════════════════════════════════════════════════════════════════════════════
echo "install.sh: image pull retries, and no 'up' without every image"
# A fresh install (2026-09-28) lost one layer to a reset connection; the pull
# aborted, `up` created 5 of 24 services, and the client step died on a network
# that did not exist. The functions are lifted out of install.sh and run for
# real under bash, with the compose command and `sleep` stubbed.
lift() { # <function>: print its definition from install.sh
  awk -v f="$1" 'index($0, f "() {") == 1 { p = 1 } p { print } p && /^}$/ { exit }' "$ROOT/scripts/install.sh"
}
T="$WORK/pull"; mkdir -p "$T"
PULL_LIB="$(lift pull_with_retry)"
check "pull_with_retry found in install.sh" test -n "$PULL_LIB"
pull_run() { # <failures before success>: run pull_with_retry against a flaky fake
  rm -f "$T/calls" "$T/sleeps"
  FAILS="$1" T="$T" MANTLE_PULL_ATTEMPTS=3 MANTLE_PULL_BACKOFF=10 bash -c '
warn() { echo "warn: $*"; }
sleep() { echo "$1" >> "$T/sleeps"; }
fake_compose() {
  echo "$*" >> "$T/calls"
  if [ "$(wc -l < "$T/calls")" -le "$FAILS" ]; then echo "read: connection reset by peer"; return 1; fi
  echo pulled
}
PULL_ATTEMPTS="${MANTLE_PULL_ATTEMPTS:-3}"; PULL_BACKOFF="${MANTLE_PULL_BACKOFF:-10}"
set -euo pipefail
'"$PULL_LIB"'
if pull_with_retry Image fake_compose --env-file .env; then echo rc=0; else echo "rc=$?"; fi' 2>&1 || true
}
calls() { wc -l < "$T/calls" | tr -d ' '; }
sleeps() { tr '\n' ' ' < "$T/sleeps" 2>/dev/null | sed 's/ $//'; }

out=$(pull_run 0)
check "clean pull: one attempt, no wait" sh -c "echo '$out' | grep -q 'rc=0' && test $(calls) = 1 && test ! -e '$T/sleeps'"
check "the compose args are passed through, then 'pull -q'" grep -qx -- '--env-file .env pull -q' "$T/calls"
out=$(pull_run 2)
check "a transient failure is retried until it succeeds" sh -c "echo '$out' | grep -q 'rc=0' && test $(calls) = 3"
check "backoff doubles between attempts (10s, 20s)" test "$(sleeps)" = "10 20"
check "each retry is announced" sh -c "echo '$out' | grep -q 'attempt 1 of 3' && echo '$out' | grep -q 'attempt 2 of 3'"
check "compose output is indented, not swallowed" sh -c "echo '$out' | grep -q '^    read: connection reset by peer'"
out=$(pull_run 9)
check "gives up after the last attempt with a non-zero status" sh -c "echo '$out' | grep -q 'rc=1' && test $(calls) = 3"
check "no wait after the last attempt" test "$(sleeps)" = "10 20"

# The gate itself: the server `up` must sit behind a failed-pull exit.
gate=$(grep -n 'if ! pull_with_retry "Image"' "$ROOT/scripts/install.sh" | head -1 | cut -d: -f1)
upl=$(grep -n '"\${COMPOSE\[@\]}" up -d --wait' "$ROOT/scripts/install.sh" | head -1 | cut -d: -f1)
check "the server pull is gated before 'up -d --wait'" test -n "$gate" -a -n "$upl" -a "${gate:-0}" -lt "${upl:-0}"
check "a failed pull exits with the re-run hint" sh -c "sed -n '${gate:-1},${upl:-1}p' '$ROOT/scripts/install.sh' | grep -q 'Re-run the installer, it is safe' && sed -n '${gate:-1},${upl:-1}p' '$ROOT/scripts/install.sh' | grep -q 'exit 1'"
check "the old 'continuing anyway' path is gone" sh -c "! grep -q 'Continuing so the sanity check can report' '$ROOT/scripts/install.sh'"

# ═════════════════════════════════════════════════════════════════════════════
echo "install.sh: the client step checks the server network first"
NET_LIB="$(lift client_network_ready)"
check "client_network_ready found in install.sh" test -n "$NET_LIB"
net_run() { # <stack dir> <network docker knows about>
  STACK_DIR="$1" HAVE_NET="$2" bash -c '
docker() { [ "$1 $2" = "network inspect" ] && [ "$3" = "$HAVE_NET" ]; }
'"$NET_LIB"'
if client_network_ready; then echo "ready $CLIENT_NET"; else echo "missing $CLIENT_NET"; fi'
}
check "reads the network the real client compose joins (mantle_default)" test "$(net_run "$ROOT" mantle_default)" = "ready mantle_default"
check "reports it missing when docker has no such network" test "$(net_run "$ROOT" nothing)" = "missing mantle_default"
mkdir -p "$T/net"
printf 'services:\n  client-web:\n    networks: [x]\nnetworks:\n  x:\n    external: true\n    name: "brain_default"\nvolumes:\n  v:\n    name: not_this\n' > "$T/net/docker-compose.client.yml"
check "follows a renamed network, quotes stripped" test "$(net_run "$T/net" brain_default)" = "ready brain_default"
check "falls back to mantle_default without a client compose" test "$(net_run "$T/nowhere" mantle_default)" = "ready mantle_default"

# ═════════════════════════════════════════════════════════════════════════════
echo "sanity.sh: our own HTTP->HTTPS redirect is not 'not Mantle'"
# The first run of that same install printed "http://localhost answered HTTP
# 308, but it is not Mantle": Caddy redirecting to HTTPS for the configured
# domain. Whole script, with docker and curl stubbed on PATH.
T="$WORK/sanity"; mkdir -p "$T/bin" "$T/stack"
printf 'MANTLE_SITE_ADDRESS=brain.example.com\n' > "$T/stack/.env"
cat > "$T/bin/docker" <<'STUB'
#!/bin/sh
case "$1" in
  info) exit 0 ;;
  ps) case "$*" in *project=mantle\ *) echo mantle_web ;; esac; exit 0 ;;
  inspect)
    case "$*" in
      *State.Status*) echo "running healthy 0" ;;
      *NetworkSettings.Networks*) echo "mantle_default " ;;
    esac; exit 0 ;;
esac
exit 0
STUB
# curl: $CURL_HTTPS / $CURL_HTTP / $CURL_DEBUG = "down" or "<code> <redirect-url|-> <body>"
cat > "$T/bin/curl" <<'STUB'
#!/bin/sh
for a in "$@"; do url=$a; done
case "$url" in
  http://127.0.0.1:*) r=$CURL_DEBUG ;;
  https://*) r=$CURL_HTTPS ;;
  *) r=$CURL_HTTP ;;
esac
[ "$r" = down ] && { printf '\n\n000'; exit 7; }
code=${r%% *}; rest=${r#* }; loc=${rest%% *}; body=${rest#* }
[ "$loc" = - ] && loc=
printf '%s\n%s\n%s' "$body" "$loc" "$code"
STUB
chmod +x "$T/bin/docker" "$T/bin/curl"
sanity_run() { # <https> <http> → output, then "rc=N"
  PATH="$T/bin:$PATH" CURL_HTTPS="$1" CURL_HTTP="$2" CURL_DEBUG=down NO_COLOR=1 \
    MANTLE_STACK_DIR="$T/stack" MANTLE_ENV_FILE="$T/stack/.env" MANTLE_COMPOSE_PROJECT=mantle \
    bash "$ROOT/scripts/sanity.sh" 2>&1; echo "rc=$?"
}
out=$(sanity_run down '308 https://brain.example.com/api/auth/bootstrap-state -')
check "308 to https on the site address: not reported as 'not Mantle'" sh -c "! printf '%s' \"\$1\" | grep -q 'not Mantle'" _ "$out"
check "308 to https on the site address: named as the HTTPS redirect" sh -c "printf '%s' \"\$1\" | grep -q 'http://localhost redirects to HTTPS (HTTP 308)'" _ "$out"
check "...and the install still fails when HTTPS never answered" sh -c "printf '%s' \"\$1\" | grep -q 'rc=1'" _ "$out"
out=$(sanity_run down '308 https://LOCALHOST/api/auth/bootstrap-state -')
check "308 to https on the probed host itself: the redirect too" sh -c "printf '%s' \"\$1\" | grep -q 'redirects to HTTPS' && ! printf '%s' \"\$1\" | grep -q 'not Mantle'" _ "$out"
out=$(sanity_run down '308 https://parked.example.net/ -')
check "a redirect to some other host is still 'not Mantle'" sh -c "printf '%s' \"\$1\" | grep -q 'http://localhost answered HTTP 308, but it is not Mantle'" _ "$out"
out=$(sanity_run down '301 http://brain.example.com/ -')
check "a redirect to plain http is still 'not Mantle'" sh -c "printf '%s' \"\$1\" | grep -q 'answered HTTP 301, but it is not Mantle'" _ "$out"
out=$(sanity_run down '200 - <html>nginx</html>')
check "a 200 from something else is still 'not Mantle'" sh -c "printf '%s' \"\$1\" | grep -q 'answered HTTP 200, but it is not Mantle'" _ "$out"
out=$(sanity_run '200 - {"firstRun":false}' down)
check "Mantle over HTTPS on the site address: verified, rc 0" sh -c "printf '%s' \"\$1\" | grep -q 'App responding at https://brain.example.com → HTTP 200 (verified Mantle)' && printf '%s' \"\$1\" | grep -q 'rc=0'" _ "$out"

# ═════════════════════════════════════════════════════════════════════════════
echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
