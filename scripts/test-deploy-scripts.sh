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
#   scripts: .pre-adopt backups are pruned to the newest three per script;
#            a script the release adds is installed at the updater's startup
#   pull:    install.sh retries a failed image pull with backoff, and never
#            runs `up` on a partial pull; the client step checks the server
#            network exists before joining it
#   setup:   install.sh writes the first-run setup code once, keeps it on a
#            re-run, and --setup-code prints it again (or says "claimed")
#   onboard: onboard.sh pipes secrets from files on stdin, never in argv
#   sanity:  Caddy's own HTTP->HTTPS redirect is not reported as "not Mantle"

#   dump:    db-dump.sh strict mode exits non-zero when any of the four parts
#            failed, and writes into MANTLE_DUMP_DIR
#   backup:  the updater's pre-roll backup (strict, retention, disk check,
#            opt-out) and a whole roll refused with nothing changed when it fails
#   floor:   a roll below v0.232.318 is refused with nothing changed while any
#            client login exists (or they cannot be counted), unless .env says so
#   prune:   after an OK roll only old mantle-server / mantle-client images go;
#            the rollback pair, the running pair and other repositories stay
#   roll:    scripts/roll.sh backs up first (its own exit status), requests
#            only the target, and stops loudly on a lost app, sandbox or
#            app-db file
#   maint:   scripts/box-maintain.sh starts a --rm sibling of mantle_web with
#            its own memory, hands the env over a pipe (never argv or disk),
#            and refuses a second maintenance run on the box

# Test code: single-quoted shell bodies are expanded by the shell they are
# handed to (SC2016), and ls over fixture dirs whose names we chose is fine
# (SC2010, SC2012). File-wide, so it sits before the first command.
# shellcheck disable=SC2010,SC2012,SC2016

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
SCRIPTS='db-dump.sh db-restore.sh install.sh sanity.sh compose-adopt.sh uninstall.sh onboard.sh'
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
echo "updater.sh: a script the release adds is installed at startup, not a roll late"
# refresh_scripts runs in the OLD updater with the OLD SCRIPT_NAMES; the copy
# it swaps in re-execs and must fetch what that list missed (onboard.sh).
T="$WORK/topup"; fake_stack "$T"
for s in $SCRIPTS; do printf '#!/bin/sh\necho %s\n' "$s" > "$T/img/scripts/$s"; done
for s in $SCRIPTS; do [ "$s" = onboard.sh ] || { cp "$T/img/scripts/$s" "$T/stack/scripts/$s"; cp "$T/img/scripts/$s" "$T/stack/scripts/$s.release"; }; done
out=$(updater_run "$T/stack" "$T/sig" "$T/img" 'container_image() { echo sha256:running; }; topup_scripts >/dev/null; echo "SCRIPTS_REFRESH=$SCRIPTS_REFRESH IMG=$IMG"')
check "the missing script is installed from the running web image" sh -c "test '$out' = 'SCRIPTS_REFRESH=refreshed IMG=sha256:running' && cmp -s '$T/stack/scripts/onboard.sh' '$T/img/scripts/onboard.sh'"
check "it is executable and has its baseline" sh -c "test -x '$T/stack/scripts/onboard.sh' && test -f '$T/stack/scripts/onboard.sh.release'"
out=$(updater_run "$T/stack" "$T/sig" "$T/img" 'container_image() { echo sha256:running; }; docker() { echo "docker $*" >> "'"$T"'/dockercalls"; }; topup_scripts; echo "SCRIPTS_REFRESH=$SCRIPTS_REFRESH"')
check "nothing missing: a no-op, docker never called" sh -c "test '$out' = 'SCRIPTS_REFRESH=none' && test ! -e '$T/dockercalls'"
rm -f "$T/stack/scripts/onboard.sh" "$T/stack/scripts/onboard.sh.release"
out=$(updater_run "$T/stack" "$T/sig" "$T/img" 'container_image() { :; }; topup_scripts; echo "SCRIPTS_REFRESH=$SCRIPTS_REFRESH"')
check "web not running: nothing to read from, nothing done" sh -c "test '$out' = 'SCRIPTS_REFRESH=none' && test ! -e '$T/stack/scripts/onboard.sh'"
startup=$(grep -n '^  topup_scripts$' "$ROOT/infra/updater/updater.sh" | cut -d: -f1)
loop=$(grep -n '^while true; do$' "$ROOT/infra/updater/updater.sh" | cut -d: -f1)
check "startup calls it before the poll loop" test -n "$startup" -a -n "$loop" -a "${startup:-0}" -lt "${loop:-0}"

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
echo "install.sh: the setup code is generated once, kept, and printed again"
# While auth.users is empty, signup makes its caller the owner; the setup code
# is what stops the first stranger to reach a fresh box from claiming it. A
# whole --skip-up run, with docker, curl and the port probes stubbed on PATH.
T="$WORK/setup"; mkdir -p "$T/bin" "$T/stack/scripts"
cp "$ROOT/docker-compose.yml" "$T/stack/"
cp "$ROOT/scripts/install.sh" "$T/stack/scripts/install.sh"
cat > "$T/bin/docker" <<'STUB'
#!/bin/sh
case "$1 $2" in
  "compose version") echo v2.30.0 ;;
esac
exit 0
STUB
# curl: only the bootstrap-state probe matters here; $CURL_BOOT is its body,
# unset means the brain is not reachable.
cat > "$T/bin/curl" <<'STUB'
#!/bin/sh
[ -n "${CURL_BOOT:-}" ] || exit 7
printf '%s' "$CURL_BOOT"
STUB
printf '#!/bin/sh\nexit 0\n' > "$T/bin/ss"     # nothing listening
# A small /tmp must not fail the installer's disk preflight: report 100 GB free.
printf '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "fake 209715200 0 104857600 0%% /"\n' > "$T/bin/df"
printf '#!/bin/sh\nexit 1\n' > "$T/bin/lsof"
chmod +x "$T/bin/"*
install_run() { # <args...>: run the configurator in the fake stack
  PATH="$T/bin:$PATH" NO_COLOR=1 bash "$T/stack/scripts/install.sh" "$@" < /dev/null > "$T/out" 2>&1
}
code_line() { grep -E '^MANTLE_SETUP_CODE=' "$T/stack/.env" | cut -d= -f2-; }

if install_run --localhost -y --skip-up --data-dir "$T/stack/data"; then ok "a --skip-up install runs to completion"
else fail "a --skip-up install exited non-zero (see below)"; sed 's/^/    /' "$T/out"; fi
first="$(code_line)"
check "the setup code is written to .env" test -n "$first"
check "4 groups of 5 from the no-look-alikes alphabet" sh -c "echo '$first' | grep -Eqx '[2-9A-HJKMNP-Z]{5}(-[2-9A-HJKMNP-Z]{5}){3}'"
check "--skip-up says how to print it" grep -q 'install.sh --setup-code' "$T/out"
install_run --localhost -y --skip-up --data-dir "$T/stack/data" || true
check "a re-run keeps the same code" test "$(code_line)" = "$first"
check "and writes it once" test "$(grep -c '^MANTLE_SETUP_CODE=' "$T/stack/.env")" = 1
check "a re-run says it was kept" grep -q 'MANTLE_SETUP_CODE kept' "$T/out"
check "two installs do not share a code" sh -c "test \"\$(env PATH='$T/bin':\"\$PATH\" bash -c \"\$(awk 'index(\$0, \"gen_setup_code() {\") == 1 { p = 1 } p { print } p && /^}\$/ { exit }' '$ROOT/scripts/install.sh'); gen_setup_code\")\" != '$first'"

CURL_BOOT='{"firstRun":true,"setupCodeRequired":true}' install_run --setup-code || true
check "--setup-code prints the code while the brain is unclaimed" grep -q "Setup code: $first" "$T/out"
CURL_BOOT='{"firstRun":false,"setupCodeRequired":false}' install_run --setup-code || true
check "--setup-code says 'already claimed' once an account exists" sh -c "grep -q 'already claimed' '$T/out' && ! grep -q '$first' '$T/out'"
install_run --setup-code || true
check "--setup-code still prints it when the brain cannot be asked" sh -c "grep -q 'Setup code: $first' '$T/out' && grep -q 'Could not ask the brain' '$T/out'"
rm -f "$T/stack/.env"
if install_run --setup-code; then fail "--setup-code without a .env should fail"; else ok "--setup-code without a .env fails and says why"; fi
check "  (it names the fix)" grep -q 'Run scripts/install.sh to create one' "$T/out"

# ═════════════════════════════════════════════════════════════════════════════
echo "onboard.sh: secrets reach the container on stdin, never in argv"
# The terminal wizard takes the owner password and the OpenRouter key from
# files and pipes them in; argv lands in shell history and in `ps`. docker is
# stubbed: it records every argv and whatever arrives on stdin for `exec -T`.
T="$WORK/onboard"; mkdir -p "$T/bin" "$T/stack/scripts"
cp "$ROOT/docker-compose.yml" "$T/stack/"
cp "$ROOT/scripts/onboard.sh" "$T/stack/scripts/onboard.sh"
cat > "$T/bin/docker" <<'STUB'
#!/bin/sh
echo "argv: $*" >> "$T/calls"
case "$*" in
  "compose ps --status running --services") [ -n "${WEB_DOWN:-}" ] || echo web ;;
  *"exec -T web"*) cat > "$T/stdin" ;;
esac
exit 0
STUB
chmod +x "$T/bin/docker"
printf 'pw-%s\n' "s3cret-value" > "$T/pw"; printf 'sk-or-v1-%s\n' "keyvalue" > "$T/key"
onboard_run() { rm -f "$T/calls" "$T/stdin"; T="$T" PATH="$T/bin:$PATH" bash "$T/stack/scripts/onboard.sh" "$@" < /dev/null > "$T/out" 2>&1; }
onboard_run --yes --email o@example.invalid --password-file "$T/pw" --key-file "$T/key"
check "the wizard runs in the web container with --secrets-stdin" grep -q 'exec -T web pnpm -C server/web exec tsx scripts/onboard.ts --secrets-stdin --yes --email o@example.invalid' "$T/calls"
check "stdin carries both secrets as key=value lines" sh -c "grep -qx 'password=pw-s3cret-value' '$T/stdin' && grep -qx 'openrouter_key=sk-or-v1-keyvalue' '$T/stdin'"
check "no argv ever holds a secret" sh -c "! grep -q -e s3cret-value -e keyvalue '$T/calls'"
WEB_DOWN=1 onboard_run --yes || true
check "a stopped web service is named, and nothing is exec'd" sh -c "grep -q \"web service isn't running\" '$T/out' && ! grep -q 'exec' '$T/calls'"
onboard_run --password-file "$T/nope" || true
check "an unreadable secret file stops before docker exec" sh -c "grep -q \"Can't read the password file\" '$T/out' && ! grep -q 'exec' '$T/calls'"
onboard_run --yes || true
check "without a terminal or files it still uses exec -T (no -it)" sh -c "grep -q 'exec -T web' '$T/calls' && ! grep -q 'exec -it' '$T/calls'"
# Relative secret paths mean relative to where the operator ran it, not the
# stack dir the script cd's into; --flag=path works too.
mkdir -p "$T/elsewhere"; printf 'rel-pass\n' > "$T/elsewhere/pw"; printf 'rel-key\n' > "$T/elsewhere/key"
rm -f "$T/calls" "$T/stdin"
(cd "$T/elsewhere" && T="$T" PATH="$T/bin:$PATH" bash "$T/stack/scripts/onboard.sh" --yes --password-file=pw --key-file ./key < /dev/null > "$T/out" 2>&1) || true
check "relative paths resolve from the caller's directory, --flag=path form included" sh -c "grep -qx 'password=rel-pass' '$T/stdin' && grep -qx 'openrouter_key=rel-key' '$T/stdin'"
onboard_run --yes --key-file || true
check "a path flag given last is a clear error, and nothing is exec'd" sh -c "grep -q -- '--key-file needs a path' '$T/out' && ! grep -q 'exec' '$T/calls' 2>/dev/null"
onboard_run --password-file= || true
check "an empty --flag= is the same clear error" grep -q -- '--password-file needs a path' "$T/out"

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

echo "db-dump.sh: strict mode and the dump dir"
# An executable docker stub on PATH (db-dump.sh runs as its own process).
# FAKE_RUNNING lists the running containers; FAKE_FAIL names a step to fail:
# pg (pg_dump), appdb (the app-db snapshot).
mkdir -p "$WORK/dumpbin"
cat > "$WORK/dumpbin/docker" <<'STUB'
#!/bin/sh
case "$1" in
  ps) for c in $FAKE_RUNNING; do echo "$c"; done; exit 0 ;;
  exec)
    shift; shift   # exec <container>
    case "$*" in
      *pg_isready*) exit 0 ;;
      *pg_dump*) [ "${FAKE_FAIL:-}" = pg ] && { echo "pg_dump: boom" >&2; exit 1; }; echo PGDUMP; exit 0 ;;
      *backup-app-dbs*) [ "${FAKE_FAIL:-}" = appdb ] && { echo "tsx: boom" >&2; exit 1; }; echo APPDB; exit 0 ;;
      *backup-table-dbs*) echo TABLEDB; exit 0 ;;
      *'tar -C "$MANTLE_SPACES_ROOT"'*) echo SPACES; exit 0 ;;
      *) exit 0 ;;
    esac ;;
esac
exit 0
STUB
chmod +x "$WORK/dumpbin/docker"
dump_run() { # <name> <env...>: run db-dump.sh from a copy of scripts/, into $WORK/dump-<name>
  local name="$1"; shift
  mkdir -p "$WORK/dumptree-$name/scripts"
  cp "$ROOT/scripts/db-dump.sh" "$WORK/dumptree-$name/scripts/"
  # shellcheck disable=SC2086  # DUMP_SHELL may be two words ("busybox sh")
  env PATH="$WORK/dumpbin:$PATH" MANTLE_DUMP_DIR="$WORK/dump-$name" \
    FAKE_RUNNING="mantle_pg mantle_web" "$@" \
    ${DUMP_SHELL:-bash} "$WORK/dumptree-$name/scripts/db-dump.sh" > "$WORK/dump-$name.log" 2>&1
}
count_in() { ls -1 "$1" 2>/dev/null | grep -c "$2" || true; }

dump_run ok MANTLE_DUMP_STRICT=1 && rc=0 || rc=$?
check "all four parts ok: strict exits 0" test "$rc" = 0
check "all four parts ok: the set is in MANTLE_DUMP_DIR" test "$(ls -1 "$WORK/dump-ok" | wc -l | tr -d ' ')" = 4
check "all four parts ok: nothing written to ./backups" test ! -e "$WORK/dumptree-ok/backups"

dump_run lax FAKE_FAIL=appdb && rc=0 || rc=$?
check "app-db part fails, not strict: still exits 0 (default unchanged)" test "$rc" = 0
check "app-db part fails, not strict: the report names the part" grep -q 'INCOMPLETE backup set.*app-dbs' "$WORK/dump-lax.log"

dump_run strict FAKE_FAIL=appdb MANTLE_DUMP_STRICT=1 && rc=0 || rc=$?
check "app-db part fails, strict: exits 3" test "$rc" = 3
check "app-db part fails, strict: the Postgres dump is kept" test "$(count_in "$WORK/dump-strict" '^mantle-[0-9-]*\.dump$')" = 1
check "app-db part fails, strict: no app-db archive left" test "$(count_in "$WORK/dump-strict" app-dbs)" = 0

dump_run nopg FAKE_FAIL=pg MANTLE_DUMP_STRICT=1 && rc=0 || rc=$?
check "pg_dump fails: exits non-zero" test "$rc" != 0
check "pg_dump fails: no .dump file left behind" test "$(count_in "$WORK/dump-nopg" '\.dump$')" = 0

dump_run noweb FAKE_RUNNING=mantle_pg MANTLE_DUMP_STRICT=1 && rc=0 || rc=$?
check "app container down, strict: exits 3" test "$rc" = 3
check "app container down, strict: all three file parts named" grep -q 'NOT backed up: app-dbs table-dbs spaces' "$WORK/dump-noweb.log"

if command -v dash >/dev/null 2>&1; then
  check "db-dump.sh parses as POSIX sh (the updater runs it under busybox sh)" dash -n "$ROOT/scripts/db-dump.sh"
fi
if command -v busybox >/dev/null 2>&1; then
  # The sidecar's shell: the strict contract must hold there, not just in bash.
  DUMP_SHELL="busybox sh" dump_run bb-ok MANTLE_DUMP_STRICT=1 && rc=0 || rc=$?
  check "busybox sh: all four parts, exit 0" sh -c "test '$rc' = 0 && test \"\$(ls -1 '$WORK/dump-bb-ok' | wc -l | tr -d ' ')\" = 4"
  DUMP_SHELL="busybox sh" dump_run bb-strict FAKE_FAIL=appdb MANTLE_DUMP_STRICT=1 && rc=0 || rc=$?
  check "busybox sh: a failed part, strict, exits 3" test "$rc" = 3
  DUMP_SHELL="busybox sh" dump_run bb-nopg FAKE_FAIL=pg MANTLE_DUMP_STRICT=1 && rc=0 || rc=$?
  check "busybox sh: pg_dump fails, exits non-zero, no .dump left" sh -c "test '$rc' != 0 && ! ls '$WORK/dump-bb-nopg' 2>/dev/null | grep -q dump"
fi

# ═════════════════════════════════════════════════════════════════════════════
# The roll stub: a richer docker for the backup, prune and whole-roll tests.
# Every call is logged to $CALLS. Container images live in $FAKE_STATE/<name>
# and `compose ... up` moves them to $FAKE_STATE/<name>.next, the way a roll
# swaps what a container runs. `image ls` prints $FAKE_STATE/images for ANY
# filter (the worst case: the updater must pick its repository itself), and
# `rmi` refuses whatever $FAKE_STATE/in-use lists.
ROLL_STUB='
docker() {
  echo "docker $*" >> "$CALLS"
  case "$1" in
    create) echo fakecid; return 0 ;;
    rm|pull) return 0 ;;
    cp)
      src=${2#*:}; src=${src#/app/release/}
      if [ -d "$FAKE_IMG/$src" ]; then cp -R "$FAKE_IMG/$src" "$3"
      elif [ -f "$FAKE_IMG/$src" ]; then cp "$FAKE_IMG/$src" "$3"
      else return 1; fi
      return 0 ;;
    inspect) cat "$FAKE_STATE/$4" 2>/dev/null || return 1; return 0 ;;
    exec) [ -z "${FAKE_EXEC_FAIL:-}" ] || return 1; echo "${FAKE_EXEC_OUT:-1000}"; return 0 ;;
    image) cat "$FAKE_STATE/images"; return 0 ;;
    rmi) grep -qxF "$2" "$FAKE_STATE/in-use" 2>/dev/null && return 1; echo "$2" >> "$FAKE_STATE/removed"; return 0 ;;
    compose)
      case "$*" in
        *"config --services"*) printf "web\nupdater\n"; return 0 ;;
        *" up "*)
          for c in mantle_web mantle_client_web; do
            [ -f "$FAKE_STATE/$c.next" ] && cp "$FAKE_STATE/$c.next" "$FAKE_STATE/$c"
          done
          return 0 ;;
      esac
      return 0 ;;
  esac
  return 0
}
'
roll_lib() { # <root> <body>: source the updater in library mode under the roll stub
  MANTLE_STACK_DIR="$1/stack" MANTLE_SIGNAL_DIR="$1/sig" FAKE_IMG="$1/img" FAKE_STATE="$1/state" \
    CALLS="$1/calls" MANTLE_UPDATER_LIB=1 "$SH" -c "$ROLL_STUB
. '$ROOT/infra/updater/updater.sh'
$2"
}
# fake_dump <root>: a scripts/db-dump.sh that writes a set stamped $FAKE_TS
# into MANTLE_DUMP_DIR (FAKE_DUMP=ok), writes half a set and exits 3
# (FAKE_DUMP=fail), or ignores MANTLE_DUMP_DIR like a pre-fix script
# (FAKE_DUMP=stale). It records that it ran, and the strict flag it saw.
fake_dump() {
  mkdir -p "$1/state"
  cat > "$1/stack/scripts/db-dump.sh" <<'DUMP'
#!/bin/sh
echo "strict=${MANTLE_DUMP_STRICT:-} pg=${MANTLE_PG_CONTAINER:-} app=${MANTLE_APP_CONTAINER:-}" > "$FAKE_STATE/dump-ran"
[ -z "${CALLS:-}" ] || echo "db-dump.sh" >> "$CALLS"
d=${MANTLE_DUMP_DIR:-backups}
case "${FAKE_DUMP:-ok}" in
  ok) for f in "mantle-$FAKE_TS.dump" "mantle-app-dbs-$FAKE_TS.tgz" "mantle-table-dbs-$FAKE_TS.tgz" "mantle-spaces-$FAKE_TS.tgz"; do
        echo data > "$d/$f"; done; exit 0 ;;
  fail) echo data > "$d/mantle-$FAKE_TS.dump"; echo "app-db snapshot FAILED" >&2; exit 3 ;;
  stale) mkdir -p "$(dirname "$0")/../backups"; echo data > "$(dirname "$0")/../backups/mantle-$FAKE_TS.dump"; exit 0 ;;
esac
DUMP
}
old_set() { # <dir> <stamp>: a complete earlier pre-roll set
  mkdir -p "$1"
  for f in "mantle-$2.dump" "mantle-app-dbs-$2.tgz" "mantle-table-dbs-$2.tgz" "mantle-spaces-$2.tgz"; do echo old > "$1/$f"; done
}
prb_probe='free_kb() { echo "${FAKE_FREE_KB:-99999999}"; }
if pre_roll_backup >/dev/null; then echo "rc=0"; else echo "rc=1 err=$PRB_ERR"; fi'

# ═════════════════════════════════════════════════════════════════════════════
echo "updater.sh: pre-roll backup"
T="$WORK/prb-ok"; fake_stack "$T"; fake_dump "$T"
P="$T/stack/backups/pre-roll"
for s in 20260101-000000 20260102-000000 20260103-000000 20260104-000000; do old_set "$P" "$s"; done
echo mine > "$T/stack/backups/operator-own.dump"
out=$(FAKE_TS=20260105-000000 roll_lib "$T" "$prb_probe")
check "ok: returns 0" test "$out" = "rc=0"
check "ok: db-dump ran strict, with the container names" grep -qx 'strict=1 pg=mantle_pg app=mantle_web' "$T/state/dump-ran"
check "ok: the new set is complete" test "$(ls "$P" | grep -c 20260105-000000)" = 4
check "ok: keeps the newest three sets (default)" test "$(ls "$P" | grep -c '\.dump$')" = 3
check "ok: the two oldest sets are gone, whole" sh -c "! ls '$P' | grep -q '2026010[12]'"
check "ok: the operator's own backups/ file is untouched" test -f "$T/stack/backups/operator-own.dump"
check "ok: the log lists the set" grep -q 'pre-roll backup ok: .*mantle-20260105-000000.dump' "$T/sig/update.log"
check "ok: the dump is 0600 (a whole-brain dump, not for every host user)" test "$(mode_of "$P/mantle-20260105-000000.dump")" = 600

T="$WORK/prb-keep"; fake_stack "$T"; fake_dump "$T"; P="$T/stack/backups/pre-roll"
for s in 20260101-000000 20260102-000000; do old_set "$P" "$s"; done
printf 'MANTLE_PRE_ROLL_KEEP=1\n' >> "$T/stack/.env"
out=$(FAKE_TS=20260105-000000 roll_lib "$T" "$prb_probe")
check "MANTLE_PRE_ROLL_KEEP=1 keeps only the new set" test "$(ls "$P" | tr '\n' ' ')" = "mantle-20260105-000000.dump mantle-app-dbs-20260105-000000.tgz mantle-spaces-20260105-000000.tgz mantle-table-dbs-20260105-000000.tgz "

T="$WORK/prb-fail"; fake_stack "$T"; fake_dump "$T"; P="$T/stack/backups/pre-roll"
old_set "$P" 20260101-000000
out=$(FAKE_TS=20260105-000000 FAKE_DUMP=fail roll_lib "$T" "$prb_probe")
check "dump fails: refused, with the exit code" test "$out" = "rc=1 err=db-dump.sh failed (exit 3), see update.log"
check "dump fails: its half set is removed" sh -c "! ls '$P' | grep -q 20260105"
check "dump fails: earlier sets are untouched" test "$(ls "$P" | grep -c 20260101-000000)" = 4

T="$WORK/prb-stale"; fake_stack "$T"; fake_dump "$T"
out=$(FAKE_TS=20260105-000000 FAKE_DUMP=stale roll_lib "$T" "$prb_probe")
check "a db-dump.sh that ignores MANTLE_DUMP_DIR: refused" sh -c "printf '%s' '$out' | grep -q 'wrote no Postgres dump into backups/pre-roll'"

T="$WORK/prb-disk"; fake_stack "$T"; fake_dump "$T"
out=$(FAKE_TS=20260105-000000 FAKE_FREE_KB=4000000 roll_lib "$T" "$prb_probe")
check "too little disk: refused with the numbers" sh -c "printf '%s' '$out' | grep -q 'not enough disk for the pre-roll backup: 3906 MB free, need 4097 MB'"
check "too little disk: db-dump never ran" test ! -e "$T/state/dump-ran"
old_set "$T/stack/backups/pre-roll" 20260101-000000
dd if=/dev/zero of="$T/stack/backups/pre-roll/mantle-20260101-000000.dump" bs=1024 count=2048 2>/dev/null
out=$(FAKE_TS=20260105-000000 FAKE_FREE_KB=5000000 roll_lib "$T" "$prb_probe")
check "the estimate follows the last set (2 MB x 1.5 + 4096 MB fits in 4882 MB)" test "$out" = "rc=0"

T="$WORK/prb-off"; fake_stack "$T"; fake_dump "$T"
printf 'MANTLE_PRE_ROLL_BACKUP=0\n' >> "$T/stack/.env"
out=$(FAKE_TS=20260105-000000 roll_lib "$T" "$prb_probe")
check "MANTLE_PRE_ROLL_BACKUP=0: goes ahead" test "$out" = "rc=0"
check "MANTLE_PRE_ROLL_BACKUP=0: says so loudly" grep -q 'PRE-ROLL BACKUP SKIPPED' "$T/sig/update.log"
check "MANTLE_PRE_ROLL_BACKUP=0: no dump ran" test ! -e "$T/state/dump-ran"

# ═════════════════════════════════════════════════════════════════════════════
# roll_loop <root>: run the REAL poll loop once. `sleep` is stubbed to exit,
# so one request is handled and the shell ends at the loop's first idle tick.
roll_loop() {
  MANTLE_STACK_DIR="$1/stack" MANTLE_SIGNAL_DIR="$1/sig" FAKE_IMG="$1/img" FAKE_STATE="$1/state" \
    CALLS="$1/calls" "$SH" -c "$ROLL_STUB
sleep() { exit 0; }
. '$ROOT/infra/updater/updater.sh'" > "$1/loop.out" 2>&1
}
roll_case() { # <name>: a stack with a request for v8, images and containers
  T="$WORK/roll-$1"; fake_stack "$T"; fake_dump "$T"
  # A configured box has its operator scripts, so the updater's startup
  # top-up (topup_scripts) has nothing to fetch before the roll begins.
  for s in $SCRIPTS; do [ -f "$T/stack/scripts/$s" ] || printf '#!/bin/sh\n' > "$T/stack/scripts/$s"; done
  printf 'services: {client_web: {image: c}}\n' > "$T/stack/docker-compose.client.yml"
  printf 'MANTLE_PRE_ROLL_MIN_FREE_MB=0\n' >> "$T/stack/.env"
  printf '{"target":"v8"}\n' > "$T/sig/request.json"
  echo sha256:S7 > "$T/state/mantle_web"; echo sha256:S8 > "$T/state/mantle_web.next"
  echo sha256:C2 > "$T/state/mantle_client_web"; echo sha256:C3 > "$T/state/mantle_client_web.next"
  # newest first, as `docker image ls` lists them
  cat > "$T/state/images" <<'IMGS'
sha256:S9 test/mantle-server:v9
sha256:S8 test/mantle-server:v8
sha256:S7 test/mantle-server:v7
sha256:C3 test/mantle-client:c3
sha256:C2 test/mantle-client:c2
sha256:S6 test/mantle-server:v6
sha256:S5 test/mantle-server:<none>
sha256:S4 test/mantle-server:v4
sha256:C1 test/mantle-client:c1
sha256:X1 test/mantle-sandbox:24.04-v2
sha256:X2 test/mantle-rustfs:1.0.0
sha256:X3 caddy:2-alpine
IMGS
  echo test/mantle-server:v4 > "$T/state/in-use"
}

echo "updater.sh: a failed pre-roll backup refuses the roll with nothing changed"
roll_case refused
cp "$T/stack/.env" "$T/env.before"; cp "$T/stack/docker-compose.yml" "$T/compose.before"
FAKE_TS=20260105-000000 FAKE_DUMP=fail roll_loop "$T"
check "status: error, ok false" grep -q '"phase":"error","target":"v8".*"ok":false' "$T/sig/status.json"
check "status: says the roll was refused and why" grep -q 'roll refused, nothing changed: db-dump.sh failed (exit 3)' "$T/sig/status.json"
check ".env unchanged (no MANTLE_IMAGE_TAG write)" same "$T/stack/.env" "$T/env.before"
check "compose unchanged" same "$T/stack/docker-compose.yml" "$T/compose.before"
check "no pull of any kind" sh -c "! grep -q 'pull' '$T/calls'"
check "no compose up" sh -c "! grep -q ' up ' '$T/calls'"
check "no image removed" test ! -e "$T/state/removed"
check "the request was consumed (not retried in a loop)" test ! -e "$T/sig/request.json"

echo "updater.sh: an OK roll prunes this product's old images only"
roll_case ok
FAKE_TS=20260105-000000 roll_loop "$T"
check "status: done, ok true" grep -q '"phase":"done","target":"v8".*"ok":true' "$T/sig/status.json"
check "backup ran before the first pull, .env write or image read" \
  test "$(grep -E '^db-dump.sh|pull|create' "$T/calls" | head -1)" = "db-dump.sh"
check "removed exactly the old server tag, the dangling one and the old client" \
  test "$(sort "$T/state/removed" | tr '\n' ' ')" = "sha256:S5 test/mantle-client:c1 test/mantle-server:v6 "
check "kept the rollback pair (v7, c2) and the running pair (v8, c3)" \
  sh -c "! grep -qE 'v7|v8|c2|c3' '$T/state/removed'"
check "kept the newest pre-pulled image (v9)" sh -c "! grep -q v9 '$T/state/removed'"
check "never tried another repository (sandbox, rustfs, caddy)" sh -c "! grep -qE 'rmi .*(sandbox|rustfs|caddy|X[123])' '$T/calls'"
check "never forced a removal" sh -c "! grep -qE 'rmi .*(-f|--force)' '$T/calls'"
check "an image docker refuses (in use) is kept and logged" grep -q 'image prune: kept test/mantle-server:v4' "$T/sig/update.log"
check "each removal is logged" grep -q 'image prune: removed test/mantle-server:v6' "$T/sig/update.log"

roll_case noprune
printf 'MANTLE_IMAGE_PRUNE=0\n' >> "$T/stack/.env"
FAKE_TS=20260105-000000 roll_loop "$T"
check "MANTLE_IMAGE_PRUNE=0: roll ok, nothing removed" sh -c "grep -q '\"ok\":true' '$T/sig/status.json' && test ! -e '$T/state/removed'"

roll_case noprev
rm "$T/state/mantle_web"
FAKE_TS=20260105-000000 roll_loop "$T"
check "no running server before the roll: server images left alone" sh -c "! grep -q mantle-server '$T/state/removed' 2>/dev/null"
check "no running server before the roll: says so" grep -q 'image prune: test/mantle-server skipped' "$T/sig/update.log"

# ═════════════════════════════════════════════════════════════════════════════
echo "updater.sh: the client logins rollback floor (v0.232.318)"
tb_probe='for t in v0.232.317 0.232.317 v0.231.999 v0.9.500 v0.232.318 v0.232.319 v0.233.0 v1.0.0 latest v8 v0.232 v0.232.317.1 v0.232.x ""; do
  if tag_below "$t" "$CLIENT_FLOOR"; then printf "%s:below " "$t"; else printf "%s:ok " "$t"; fi; done'
T="$WORK/floor-lib"; fake_stack "$T"; mkdir -p "$T/state"
out=$(roll_lib "$T" "$tb_probe")
check "tag_below: only release versions under 0.232.318 are below" test "$out" = \
  "v0.232.317:below 0.232.317:below v0.231.999:below v0.9.500:below v0.232.318:ok v0.232.319:ok v0.233.0:ok v1.0.0:ok latest:ok v8:ok v0.232:ok v0.232.317.1:ok v0.232.x:ok :ok "
out=$(FAKE_EXEC_OUT=2 roll_lib "$T" 'client_logins_count')
check "client_logins_count reads the count from mantle_pg" test "$out" = 2
out=$(FAKE_EXEC_FAIL=1 roll_lib "$T" 'printf "[%s]" "$(client_logins_count)"')
check "client_logins_count is empty when Postgres cannot be read" test "$out" = "[]"
check "the count query survives a schema without the role column" \
  grep -q "to_jsonb(u)->>'role' = 'client'" "$ROOT/infra/updater/updater.sh"

floor_case() { # <name> <target>: a roll_case whose request names <target>
  roll_case "$1"
  printf '{"target":"%s"}\n' "$2" > "$T/sig/request.json"
  cp "$T/stack/.env" "$T/env.before"; cp "$T/stack/docker-compose.yml" "$T/compose.before"
}
floor_case clients v0.232.317
FAKE_TS=20260105-000000 FAKE_EXEC_OUT=1 roll_loop "$T"
check "clients exist, target below: status error, ok false" grep -q '"phase":"error","target":"v0.232.317".*"ok":false' "$T/sig/status.json"
check "clients exist, target below: says why and how many" grep -q 'roll refused, nothing changed: v0.232.317 is below v0.232.318, the floor once any client login exists (1 here)' "$T/sig/status.json"
check "clients exist, target below: .env unchanged" same "$T/stack/.env" "$T/env.before"
check "clients exist, target below: compose unchanged" same "$T/stack/docker-compose.yml" "$T/compose.before"
check "clients exist, target below: no backup, no pull, no up" sh -c "! grep -qE 'db-dump.sh|pull| up ' '$T/calls'"
check "clients exist, target below: the request was consumed" test ! -e "$T/sig/request.json"

floor_case unreadable v0.232.300
FAKE_TS=20260105-000000 FAKE_EXEC_FAIL=1 roll_loop "$T"
check "logins cannot be counted, target below: refused (fails closed)" grep -q 'roll refused, nothing changed: v0.232.300 is below v0.232.318 and the client logins could not be counted' "$T/sig/status.json"

floor_case noclients v0.232.317
FAKE_TS=20260105-000000 FAKE_EXEC_OUT=0 roll_loop "$T"
check "no client logins, target below: the roll goes ahead" grep -q '"phase":"done","target":"v0.232.317".*"ok":true' "$T/sig/status.json"

floor_case override v0.232.317
printf 'MANTLE_ALLOW_BELOW_CLIENT_FLOOR=1\n' >> "$T/stack/.env"
FAKE_TS=20260105-000000 FAKE_EXEC_OUT=3 roll_loop "$T"
check "MANTLE_ALLOW_BELOW_CLIENT_FLOOR=1: the roll goes ahead" grep -q '"phase":"done","target":"v0.232.317".*"ok":true' "$T/sig/status.json"
check "MANTLE_ALLOW_BELOW_CLIENT_FLOOR=1: says so loudly" grep -q 'ROLLING BELOW v0.232.318' "$T/sig/update.log"

floor_case atfloor v0.232.318
FAKE_TS=20260105-000000 FAKE_EXEC_OUT=3 roll_loop "$T"
check "clients exist, target at the floor: the roll goes ahead" grep -q '"phase":"done","target":"v0.232.318".*"ok":true' "$T/sig/status.json"

# ═════════════════════════════════════════════════════════════════════════════
echo "roll.sh: backup first, request only the target, stop on any count drop"
# `ssh <opts> <host> <cmd>` runs <cmd> locally (stdin passes through), and a
# docker stub plays the box: counts come from files in $RS, the updater
# consumes request.json on the next status read (applying FAKE_DROP), and
# `docker run -v <dir>:/s alpine sh -c ...` runs its command against <dir>.
RB="$WORK/rollbin"; mkdir -p "$RB"
cat > "$RB/ssh" <<'STUB'
#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -o) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift   # the host
echo "ssh $*" >> "$RS/calls"
exec sh -c "$*"
STUB
cat > "$RB/docker" <<'STUB'
#!/bin/sh
echo "docker $*" >> "$RS/calls"
case "$1" in
  inspect)
    if [ "$2" = mantle_updater ]; then
      printf '[{"Config":{"Env":["PATH=/bin","MANTLE_STACK_DIR=%s"]},"Mounts":[{"Source":"%s","Destination":"/signal"}]}]\n' "${FAKE_STACK_ENV-$RS/stack}" "$RS/sig"
      exit 0
    fi
    echo healthy; exit 0 ;;
  run)
    src=""; cmd=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -v) src=${2%%:*}; shift 2 ;;
        -c) cmd=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    exec sh -c "$(printf '%s' "$cmd" | sed "s#/s/#$src/#g")" ;;
  exec)
    case "$*" in
      *"from apps"*) cat "$RS/apps" ;;
      *"from sandboxes"*) cat "$RS/sandboxes" ;;
      *APP_DB_DIR*) cat "$RS/appdbs" ;;
      *status.json*)
        # FAKE_LAG: status reads the updater takes before it picks the
        # request up (the window where status.json still shows the LAST run).
        lag=$(cat "$RS/lag" 2>/dev/null || echo "${FAKE_LAG:-0}")
        if [ -f "$RS/sig/request.json" ] && [ "$lag" -gt 0 ]; then
          echo $((lag - 1)) > "$RS/lag"
        elif [ -f "$RS/sig/request.json" ]; then
          cp "$RS/sig/request.json" "$RS/request.seen"
          t=$(sed -n 's/.*"target":"\([^"]*\)".*/\1/p' "$RS/sig/request.json")
          rm -f "$RS/sig/request.json"
          case "${FAKE_DROP:-}" in
            apps) echo $(( $(cat "$RS/apps") - 1 )) > "$RS/apps" ;;
            files) echo $(( $(cat "$RS/appdbs") - 1 )) > "$RS/appdbs" ;;
          esac
          printf '{"phase":"%s","target":"%s","started_at":"NEW","finished_at":"F","ok":%s,"error":"%s"}\n' \
            "${FAKE_PHASE:-done}" "$t" "${FAKE_OK:-true}" "${FAKE_ERR:-}" > "$RS/sig/status.json"
          if [ -n "${FAKE_NO_BACKUP_LINE:-}" ]; then
            echo "[updater] update requested" > "$RS/sig/update.log"
          else
            echo "[updater] pre-roll backup ok: mantle-x.dump" > "$RS/sig/update.log"
          fi
        fi
        cat "$RS/sig/status.json" ;;
      *update.log*)
        # Run what was asked, as the real box would: the words exactly as
        # the remote shell split them (the ssh stub joins its arguments the
        # way ssh does), with /signal/ pointed at the fake signal dir.
        shift 2; n=$#
        while [ "$n" -gt 0 ]; do
          a=$1; shift; set -- "$@" "$(printf '%s' "$a" | sed "s#^/signal/#$RS/sig/#")"; n=$((n - 1))
        done
        exec "$@" ;;
      *api/version*) echo '{"version":"fake"}' ;;
      *) : ;;
    esac
    exit 0 ;;
esac
exit 0
STUB
chmod +x "$RB/ssh" "$RB/docker"

roll_box() { # <name>: a fake box; its db-dump.sh follows FAKE_DUMP (ok, fail, lossy)
  RS="$WORK/rollbox-$1"; mkdir -p "$RS/stack/scripts" "$RS/stack/infra/updater" "$RS/sig"
  echo 11 > "$RS/apps"; echo 2 > "$RS/sandboxes"; echo 7 > "$RS/appdbs"
  printf '{"phase":"done","target":"v7","started_at":"OLD","finished_at":"F0","ok":true,"error":""}\n' > "$RS/sig/status.json"
  printf '#!/bin/sh\necho old updater\n' > "$RS/stack/infra/updater/updater.sh"
  : > "$RS/stack/.env"
  cat > "$RS/stack/scripts/db-dump.sh" <<'DUMP'
#!/bin/sh
echo "db-dump strict=${MANTLE_DUMP_STRICT:-}" >> "$RS/calls"
case "${FAKE_DUMP:-ok}" in
  ok) echo "✔ Wrote 1M → backups/mantle-20260105-000000.dump"; exit 0 ;;
  fail) echo "✗ pg_dump FAILED" >&2; exit 1 ;;
  lossy) echo "✔ Wrote 1M → backups/mantle-20260105-000000.dump"; echo "⚠ app-db snapshot FAILED — per-app SQLite NOT backed up" >&2; exit 0 ;;
esac
DUMP
}
roll_sh() { # <args...>: run roll.sh against $RS; exit code in $rc, output in $RS/out
  rc=0
  PATH="$RB:$PATH" RS="$RS" ROLL_POLL_SECS=0 ROLL_TIMEOUT_SECS=5 ROLL_HEALTH_TIMEOUT_SECS=5 \
    bash "$ROOT/scripts/roll.sh" "$@" > "$RS/out" 2>&1 || rc=$?
}

roll_box happy
roll_sh --ssh fakebox v8
check "happy: exit 0" test "$rc" = 0
check "happy: db-dump ran strict" grep -qx 'db-dump strict=1' "$RS/calls"
check "happy: backup before the request" \
  test "$(grep -nE '^db-dump|alpine' "$RS/calls" | head -1 | cut -d: -f2 | cut -c1-7)" = "db-dump"
check "happy: request.json held only the target" test "$(cat "$RS/request.seen")" = '{"target":"v8"}'
check "happy: stack dir read from the updater" grep -q "(stack $RS/stack)" "$RS/out"
check "happy: prints /api/version" grep -q 'version: {"version":"fake"}' "$RS/out"
check "happy: counts printed before and after" sh -c "grep -q 'before: apps=11 sandboxes=2 app-db files=7' '$RS/out' && grep -q 'after:  apps=11 sandboxes=2 app-db files=7' '$RS/out'"

roll_box dumpfail
FAKE_DUMP=fail roll_sh --ssh fakebox v8
check "dump fails: exit 1" test "$rc" = 1
check "dump fails: says so" grep -q 'BACKUP FAILED: db-dump.sh exited non-zero' "$RS/out"
check "dump fails: nothing requested" sh -c "test ! -e '$RS/request.seen' && test ! -e '$RS/sig/request.json'"

roll_box lossy
FAKE_DUMP=lossy roll_sh --ssh fakebox v8
check "old db-dump loses a part but exits 0: stopped" sh -c "test '$rc' = 1 && grep -q 'BACKUP INCOMPLETE' '$RS/out'"
check "old db-dump loses a part: nothing requested" test ! -e "$RS/sig/request.json"

roll_box dropapps
FAKE_DROP=apps roll_sh --ssh fakebox v8
check "an app lost in the roll: exit 3" test "$rc" = 3
check "an app lost in the roll: loud, with the numbers" grep -q 'COUNTS DROPPED.*apps 11→10' "$RS/out"

roll_box dropfiles
FAKE_DROP=files roll_sh --ssh fakebox v8
check "an app-db file lost in the roll: exit 3" sh -c "test '$rc' = 3 && grep -q 'app-db files 7→6' '$RS/out'"

roll_box notok
FAKE_OK=false FAKE_PHASE=error FAKE_ERR="compose up failed" roll_sh --ssh fakebox v8
check "updater reports ok:false: exit 1 with its error" sh -c "test '$rc' = 1 && grep -q 'ROLL NOT OK: compose up failed' '$RS/out'"

roll_box updaterdumps
printf 'pre_roll_backup() {\n  :\n}\n' > "$RS/stack/infra/updater/updater.sh"
roll_sh --ssh fakebox v8
check "updater takes its own backup: roll.sh does not dump twice" sh -c "test '$rc' = 0 && ! grep -q '^db-dump' '$RS/calls'"
check "updater takes its own backup: its log line is checked (one quoted phrase)" grep -q "grep -q 'pre-roll backup ok' /signal/update.log" "$RS/calls"

roll_box updaterdumpsmissing
printf 'pre_roll_backup() {\n  :\n}\n' > "$RS/stack/infra/updater/updater.sh"
FAKE_NO_BACKUP_LINE=1 roll_sh --ssh fakebox v8
check "updater's log has no backup line: roll.sh stops" sh -c "test '$rc' = 1 && grep -q 'shows no pre-roll backup' '$RS/out'"
roll_box updateroptout
printf 'pre_roll_backup() {\n  :\n}\n' > "$RS/stack/infra/updater/updater.sh"
printf 'MANTLE_PRE_ROLL_BACKUP=0\n' > "$RS/stack/.env"
roll_sh --ssh fakebox v8
check "updater backup switched off in .env: roll.sh dumps itself" grep -qx 'db-dump strict=1' "$RS/calls"

roll_box dry
roll_sh --dry-run --ssh fakebox v8
check "dry run: exit 0, no dump, no request" \
  sh -c "test '$rc' = 0 && ! grep -q '^db-dump' '$RS/calls' && test ! -e '$RS/request.seen' && ! grep -q alpine '$RS/calls'"

roll_box busy
printf '{"phase":"rolling","target":"v7","started_at":"OLD","finished_at":"","ok":null,"error":""}\n' > "$RS/sig/status.json"
roll_sh --ssh fakebox v8
check "an update already running: refused before anything" sh -c "test '$rc' = 1 && ! grep -q '^db-dump' '$RS/calls'"

roll_box rerun
# Re-rolling the tag the box already runs: status.json names the SAME target
# as finished until the updater claims the request. Only a new started_at
# tells this run from the last one.
printf '{"phase":"done","target":"v8","started_at":"OLD","finished_at":"F0","ok":true,"error":""}\n' > "$RS/sig/status.json"
FAKE_LAG=3 roll_sh --ssh fakebox v8
check "same-tag re-roll: waits for the NEW run, not the last one's status" \
  sh -c "test '$rc' = 0 && grep -q '^status: .*\"started_at\":\"NEW\"' '$RS/out'"

roll_box badtag
roll_sh --ssh fakebox 'v8;rm'
check "a tag outside the whitelist: usage error" test "$rc" = 2

roll_box fleet
printf '{"boxes":[{"label":"box-a","url":"","ssh":"fakebox","stack":"%s"}]}\n' "$RS/stack" > "$RS/fleet.json"
FAKE_STACK_ENV="" MANTLE_FLEET_FILE="$RS/fleet.json" roll_sh box-a v8
check "box from the fleet file (label, ssh, stack)" sh -c "test '$rc' = 0 && grep -q '===== fakebox → v8' '$RS/out'"

roll_box fleetnostack
printf '{"boxes":[{"label":"box-b","url":"https://brain.example.com","ssh":"fakebox"}]}\n' > "$RS/fleet.json"
MANTLE_FLEET_FILE="$RS/fleet.json" roll_sh box-b v8
check "a fleet box with a url and no stack: the stack comes from the updater, not the url" sh -c "test '$rc' = 0 && ! grep -q 'not an absolute path' '$RS/out'"

# ═════════════════════════════════════════════════════════════════════════════
echo "box-maintain.sh: a sibling container, the env through a pipe, one run per box"
# A docker stub plays the box: `ps` lists $BM/running, `top` prints $BM/top,
# `inspect` answers for mantle_web (its env holds a secret and $BM/webowner),
# psql answers $BM/pgowner, and `run` records its argv and the env file it
# was handed (read through the path docker got, as the real CLI does).
BB="$WORK/bmbin"; mkdir -p "$BB"
cat > "$BB/docker" <<'STUB'
#!/bin/bash
echo "docker $*" >> "$BM/calls"
case "$1" in
  ps) cat "$BM/running" 2>/dev/null ;;
  top) cat "$BM/top" 2>/dev/null ;;
  inspect)
    [ "$2" = mantle_web ] || [ "$3" = mantle_web ] || [ "$4" = mantle_web ] || exit 1
    case "$*" in
      *'{{.Image}}'*) echo sha256:0123456789abcdef0123 ;;
      *WorkingDir*) echo /app ;;
      *Config.Env*) printf 'PATH=/usr/bin\nSECRET_KEY=topsecret\nALLOWED_USER_ID=%s\n' "$(cat "$BM/webowner" 2>/dev/null)" ;;
    esac ;;
  exec) cat "$BM/pgowner" 2>/dev/null ;;
  run)
    printf '%s\n' "$@" > "$BM/run-argv"
    while [ $# -gt 0 ]; do
      if [ "$1" = --env-file ]; then cat "$2" > "$BM/run-env"; fi
      shift
    done ;;
  logs) echo "maintain: chunk-windows (dry-run) started" ;;
esac
exit 0
STUB
printf '#!/bin/sh\nexit 0\n' > "$BB/sleep"
chmod +x "$BB/docker" "$BB/sleep"
OWNER_ID=11111111-2222-3333-4444-555555555555
bm_box() { # <name>: a fresh fake box
  BM="$WORK/bm-$1"; mkdir -p "$BM/home"; : > "$BM/calls"
}
bm_sh() { # <args...>: run box-maintain.sh on the fake box; exit code in $rc, output in $BM/out
  rc=0
  PATH="$BB:$RB:$PATH" HOME="$BM/home" BM="$BM" RS="$BM" \
    bash "$ROOT/scripts/box-maintain.sh" "$@" > "$BM/out" 2>&1 || rc=$?
}

bm_box happy
echo "$OWNER_ID" > "$BM/webowner"
bm_sh --here chunk-windows --apply --yes --parallel=16
check "happy: exit 0" test "$rc" = 0
check "happy: a --rm container named maint-<task> with its own memory, no swap" sh -c "
  grep -qx -- --rm '$BM/run-argv' && grep -qx maint-chunk-windows '$BM/run-argv' &&
  grep -A1 -x -- --memory '$BM/run-argv' | grep -qx 2g && grep -A1 -x -- --memory-swap '$BM/run-argv' | grep -qx 2g"
check "happy: mantle_web's network, image and working dir" sh -c "
  grep -qx container:mantle_web '$BM/run-argv' && grep -qx sha256:0123456789abcdef0123 '$BM/run-argv' &&
  grep -A1 -x -- --workdir '$BM/run-argv' | grep -qx /app"
check "happy: the web env reached docker through a pipe, never in argv" sh -c "
  grep -qx SECRET_KEY=topsecret '$BM/run-env' && ! grep -q topsecret '$BM/run-argv' &&
  grep -A1 -x -- --env-file '$BM/run-argv' | tail -1 | grep -q '^/dev/fd/'"
check "happy: the heap cap is 75% of the memory" grep -qx -- 'NODE_OPTIONS=--max-old-space-size=1536' "$BM/run-argv"
check "happy: the owner comes from the web env" grep -qx "ALLOWED_USER_ID=$OWNER_ID" "$BM/run-argv"
check "happy: the task and its flags pass through unchanged" sh -c "
  tail -4 '$BM/run-argv' | tr '\n' ' ' | grep -q '^chunk-windows --apply --yes --parallel=16 \$'"
check "happy: the log dir on the box is private" test "$(stat -c %a "$BM/home/maint-logs" 2>/dev/null || stat -f %Lp "$BM/home/maint-logs")" = 700

bm_box busy
echo maint-re-embed > "$BM/running"; echo "$OWNER_ID" > "$BM/webowner"
bm_sh --here chunk-windows --apply --yes
check "a maint container already runs: refused, nothing started" sh -c "
  test '$rc' = 1 && grep -q 'already going: maint-re-embed' '$BM/out' && test ! -e '$BM/run-argv'"

bm_box inweb
printf 'PID ARGS\n42 node tsx scripts/maintain.ts chunk-windows --apply\n' > "$BM/top"; echo "$OWNER_ID" > "$BM/webowner"
bm_sh --here chunk-windows
check "a pnpm maintain inside mantle_web: refused" sh -c "
  test '$rc' = 1 && grep -q 'running inside mantle_web' '$BM/out' && test ! -e '$BM/run-argv'"

bm_box pgowner
echo "$OWNER_ID" > "$BM/pgowner"
bm_sh --here --memory=3g chunk-windows
check "no owner in the web env: read from Postgres; --memory sets the heap" sh -c "
  test '$rc' = 0 && grep -qx 'ALLOWED_USER_ID=$OWNER_ID' '$BM/run-argv' &&
  grep -qx -- 'NODE_OPTIONS=--max-old-space-size=2304' '$BM/run-argv'"

bm_box noowner
bm_sh --here chunk-windows
check "no owner anywhere: refused, asks for --owner" sh -c "test '$rc' = 1 && grep -q 'pass --owner' '$BM/out'"

bm_box badslug
bm_sh --here 'chunk-windows;rm'
check "a task slug outside [a-z0-9-]: refused" test "$rc" = 1

bm_box overssh
echo "$OWNER_ID" > "$BM/webowner"
bm_sh --ssh fakebox re-embed --model='a b' --yes
check "over ssh: an argument with a space arrives as one argument" sh -c "
  test '$rc' = 0 && grep -qx -- '--model=a b' '$BM/run-argv'"

bm_box status
echo maint-chunk-windows > "$BM/running"
bm_sh --here --status
check "--status names the running container" sh -c "test '$rc' = 0 && grep -q 'maint-chunk-windows' '$BM/out'"

# ═════════════════════════════════════════════════════════════════════════════
echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
