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
#   dump:    db-dump.sh strict mode exits non-zero when any of the four parts
#            failed, and writes into MANTLE_DUMP_DIR
#   backup:  the updater's pre-roll backup (strict, retention, disk check,
#            opt-out) and a whole roll refused with nothing changed when it fails
#   prune:   after an OK roll only old mantle-server / mantle-client images go;
#            the rollback pair, the running pair and other repositories stay
#   roll:    scripts/roll.sh backs up first (its own exit status), requests
#            only the target, and stops loudly on a lost app, sandbox or
#            app-db file

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
  env PATH="$WORK/dumpbin:$PATH" MANTLE_DUMP_DIR="$WORK/dump-$name" \
    FAKE_RUNNING="mantle_pg mantle_web" "$@" \
    bash "$WORK/dumptree-$name/scripts/db-dump.sh" > "$WORK/dump-$name.log" 2>&1
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
    exec) echo 1000; return 0 ;;
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
          echo "[updater] pre-roll backup ok: mantle-x.dump" > "$RS/sig/update.log"
        fi
        cat "$RS/sig/status.json" ;;
      *update.log*) grep 'pre-roll backup ok' "$RS/sig/update.log" ;;
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
check "updater takes its own backup: its log line is checked" grep -q 'grep pre-roll backup ok' "$RS/calls"
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

# ═════════════════════════════════════════════════════════════════════════════
echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
