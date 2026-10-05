#!/bin/sh
#
# Mantle updater sidecar — the execution half of in-app updates.
#
# The web app DETECTS new releases and REQUESTS an update by writing
# /signal/request.json (a volume shared only with the app containers — no
# ports, no network surface). This script polls for that request and performs
# exactly one fixed operation:
#
#   docker compose pull && docker compose up -d <every service EXCEPT updater>
#
# framed by two fixed steps: a strict four-part pre-roll backup BEFORE it (the
# roll is refused, nothing changed, when that fails; see pre_roll_backup) and,
# after an OK roll, removal of this product's old server and client images
# (see prune_images).
#
# The updater excludes ITSELF from the `up`: recreating its own container
# mid-command would SIGKILL this script before the rollout finishes, leaving
# the rest of the stack stuck in "Created" (site down). Its image is pinned and
# updater.sh is bind-mounted, so it never needs an in-band recreate anyway.
#
# against the host's compose project (MANTLE_STACK_DIR must be the stack
# directory's HOST-ABSOLUTE path; the compose file mounts the stack at that
# same path inside this container, so bind-mount sources the daemon resolves
# stay correct).
#
# Security model: this container holds the Docker socket (root-equivalent on
# the host). Mitigations, in order: it listens on NOTHING (file-trigger via a
# private named volume), it runs one hardcoded command (the request can only
# choose the image TAG, validated to ^v?[A-Za-z0-9._-]+$), and its own image is
# the official docker CLI. Don't "improve" it into a general remote executor.
#
# This script is itself release-owned and SELF-REFRESHING: after a successful
# update it installs the canonical copy embedded in the target image and
# re-execs into it (refresh_updater below). Before v0.206 it was the one
# release-owned file nothing ever updated, so a box silently ran old update
# logic forever — the fleet-wide client-stack skip of 2026-07-26.
#
# Status surface (read by /settings/updates):
#   /signal/status.json  — {"phase","target","started_at","finished_at","ok","error"}
#   /signal/stack.json   — compose + updater-script fingerprints (drift check)
#   /signal/update.log   — full pull/up output of the current/last run
#
# Idle cost: a sleep-5 loop in one busybox sh — effectively zero.

set -u

SIG="${MANTLE_SIGNAL_DIR:-/signal}"
STACK="${MANTLE_STACK_DIR:-}"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# write_status <phase> <target> <started_at> <finished_at> <ok|""> <error>
write_status() {
  esc_err=$(printf '%s' "$6" | tr '\n"' ' .' | cut -c1-300)
  printf '{"phase":"%s","target":"%s","started_at":"%s","finished_at":"%s","ok":%s,"error":"%s"}\n' \
    "$1" "$2" "$3" "$4" "${5:-null}" "$esc_err" > "$SIG/status.json.tmp" \
    && mv "$SIG/status.json.tmp" "$SIG/status.json"
}

# ── config check ─────────────────────────────────────────────────────────────
# Re-evaluated on every request (not just at boot), so fixing .env and
# restarting this container — or even fixing .env alone — recovers without a
# rebuild. Prints the reason it's unconfigured, or nothing when all is well.
config_error() {
  if [ -z "$STACK" ] || [ ! -f "$STACK/docker-compose.yml" ]; then
    printf 'MANTLE_STACK_DIR not set (or no docker-compose.yml at "%s")' "$STACK"
  elif ! docker compose version >/dev/null 2>&1; then
    printf 'docker compose plugin unavailable in updater image'
  fi
}

# Best-effort read of the persisted phase ("" when no status yet).
cur_phase() {
  sed -n 's/.*"phase"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SIG/status.json" 2>/dev/null | head -1
}

# ── release-owned compose: drift reporting + refresh ─────────────────────────
# The canonical docker-compose.yml is owned by the RELEASE — embedded in the
# app image at /app/release/docker-compose.yml (Dockerfile). A box whose copy
# is PRISTINE (byte-identical to `docker-compose.yml.release`, the baseline of
# the canonical it was installed/last refreshed with) gets the new canonical
# swapped in automatically during an update, so compose-level changes (new
# sidecars, healthchecks, mounts, mem caps) ship WITH the image instead of
# silently drifting (the v0.137 table-dbs / v0.141 autoheal class). Box-local
# customization belongs in docker-compose.override.yml (compose merges it
# automatically) + .env — never in the canonical file. A MODIFIED canonical
# file is never overwritten: the update proceeds on the old compose and the
# drift is reported loudly (update.log + stack.json → /settings/updates).
# Security note: the extraction source is the target image itself — content
# this box is about to run anyway — so no new trust or network surface.

REFRESH=none          # last server-compose refresh outcome (stack.json)
CLIENT_REFRESH=none   # last client-compose refresh outcome (stack.json)
CORE_REFRESH=none     # last core-override refresh outcome (stack.json)
CADDY_REFRESH=none    # last Caddyfile + shapes refresh outcome (stack.json)
CADDY_RECREATE=""     # 1 when ANY front-door file changed this roll: force the caddy recreate
SCRIPTS_REFRESH=none  # last operator-scripts refresh outcome (stack.json)
UPDATER_REFRESH=none  # last updater-script refresh outcome (stack.json)

# This script's own path INSIDE the container, reached through the stack-dir
# mount rather than the /updater.sh entrypoint mount. The distinction is load-
# bearing — see refresh_updater().
UPDATER_REL=infra/updater/updater.sh
CADDY_REL=infra/caddy/Caddyfile
CADDY_SHAPES_REL=infra/caddy/shapes
SCRIPTS_REL=scripts
# The operator scripts the image ships at /app/release/scripts. MUST match the
# list release.yml puts in the deploy bundle and install.sh fetches — a script
# in one and not the others is a box that has it stale or not at all.
#
# The NAMES are part of the fingerprint (see scripts_sha_of: each line is
# 'name:hash'), and server/web/lib/updates.ts hardcodes the same list
# independently. So RENAMING one of these files is not a rename — it shifts the
# digest on every box, and during a rollout the old updater and the new web
# image disagree, which reads as "scripts drifted" fleet-wide. That is why
# scripts/install.sh still shares a name with the root bootstrap (2026-09-03
# audit); both files carry a header saying which is which instead.
SCRIPT_NAMES='db-dump.sh db-restore.sh install.sh sanity.sh compose-adopt.sh uninstall.sh onboard.sh'

sha_of() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

# One fingerprint over the whole operator-script set (suffix '' for the live
# copies, '.release' for the baselines) so /settings/updates can show "scripts
# match / drifted" as a single row instead of six.
scripts_sha_of() {
  # NAME-tagged, one line each: a bare `sha_of` prints NOTHING for a missing
  # file (sha256sum fails, cut gets empty input), so absence would vanish from
  # the digest and a half-installed box could hash identical to a complete one.
  # 'name:' with an empty hash keeps it visible, and pins the order too.
  #
  # NOTHING present at all is different in KIND, and must read as empty rather
  # than as "the hash of six blanks". The reader (server/web/lib/updates.ts)
  # distinguishes "no baseline yet — the refresh adopts it, nobody need act"
  # from "a baseline exists and disagrees — somebody hand-edited a script" by
  # testing the baseline digest for emptiness. A six-blanks hash is a perfectly
  # valid non-empty string, so a pre-adoption box (dev, v0.232.140: zero
  # scripts/*.release) reported 'modified' and demanded attention it did not
  # need — the exact case the row exists to show correctly.
  any=""
  for n in $SCRIPT_NAMES; do
    [ -f "$STACK/$SCRIPTS_REL/$n$1" ] && { any=1; break; }
  done
  [ -z "$any" ] && return 0
  for n in $SCRIPT_NAMES; do
    printf '%s:%s\n' "$n" "$(sha_of "$STACK/$SCRIPTS_REL/$n$1")"
  done | sha256sum | cut -d' ' -f1
}

# Compose + updater-script fingerprints for the web app's drift check
# (best-effort). The updater sha is what makes a stale SCRIPT visible: a box
# that cannot self-refresh (modified copy, extraction failure) otherwise
# reports a perfectly healthy update while silently running old logic.
write_stack_info() {
  printf '{"compose_sha":"%s","baseline_sha":"%s","client_compose_sha":"%s","client_baseline_sha":"%s","core_compose_sha":"%s","core_baseline_sha":"%s","updater_sha":"%s","updater_baseline_sha":"%s","caddy_sha":"%s","caddy_baseline_sha":"%s","scripts_sha":"%s","scripts_baseline_sha":"%s","refresh":"%s","client_refresh":"%s","core_refresh":"%s","updater_refresh":"%s","caddy_refresh":"%s","scripts_refresh":"%s","checked_at":"%s"}\n' \
    "$(sha_of "$STACK/docker-compose.yml")" \
    "$(sha_of "$STACK/docker-compose.yml.release")" \
    "$(sha_of "$STACK/docker-compose.client.yml")" \
    "$(sha_of "$STACK/docker-compose.client.yml.release")" \
    "$(sha_of "$STACK/docker-compose.core.yml")" \
    "$(sha_of "$STACK/docker-compose.core.yml.release")" \
    "$(sha_of "$STACK/$UPDATER_REL")" \
    "$(sha_of "$STACK/$UPDATER_REL.release")" \
    "$(sha_of "$STACK/$CADDY_REL")" \
    "$(sha_of "$STACK/$CADDY_REL.release")" \
    "$(scripts_sha_of '')" \
    "$(scripts_sha_of .release)" \
    "$REFRESH" "$CLIENT_REFRESH" "$CORE_REFRESH" "$UPDATER_REFRESH" "$CADDY_REFRESH" "$SCRIPTS_REFRESH" "$(now)" > "$SIG/stack.json.tmp" \
    && mv "$SIG/stack.json.tmp" "$SIG/stack.json"
  # The optional-service state rides every stack.json refresh (boot, the
  # ~5 min tick, after every run). Defined below; called only at run time.
  write_services_info
}

# compose_env_ok <box-file> <incoming>: can this box's .env satisfy the
# incoming compose? Since v0.232.140 the canonical marks its secrets
# `${VAR:?}`. A box installed before the installer wrote POSTGRES_PASSWORD /
# S3_* passes the pristine check, takes the swap, and then fails `compose
# pull` on interpolation with the new file already live: every compose verb
# broken until .env is hand-edited, and an error pointing at a script the box
# may not even have yet. So the incoming file is validated BEFORE the swap
# and a box that cannot satisfy it keeps its existing compose, with the exact
# variables and the lines to add written to update.log. The core file is an
# override, never valid alone, so it is checked on top of the box's server
# compose.
compose_env_ok() {
  if [ "$1" = docker-compose.core.yml ]; then
    ceo_err=$(docker compose --project-directory "$STACK" --env-file "$STACK/.env" \
      -f "$STACK/docker-compose.yml" -f "$2" config -q 2>&1 >/dev/null) && return 0
  else
    ceo_err=$(docker compose --project-directory "$STACK" --env-file "$STACK/.env" \
      -f "$2" config -q 2>&1 >/dev/null) && return 0
  fi
  # Compose stops at the first `:?` it cannot resolve; the operator wants the
  # whole list, so it is computed here from the file itself.
  ceo_missing=""
  for ceo_v in $(sed -n 's/.*\${\([A-Za-z_][A-Za-z0-9_]*\):?.*/\1/p' "$2" | sort -u); do
    grep -q "^$ceo_v=." "$STACK/.env" 2>/dev/null || ceo_missing="$ceo_missing $ceo_v"
  done
  {
    echo "[updater] $1: this box's .env cannot satisfy the incoming compose (incompatible-env)."
    if [ -n "$ceo_missing" ]; then
      echo "  Missing from .env:$ceo_missing"
      echo "  Add these lines to .env, then request the update again. The values shown are the"
      echo "  compose defaults an install older than v0.232.140 initialised its data dir with;"
      echo "  if you chose your own, use those instead:"
      for ceo_v in $ceo_missing; do
        case "$ceo_v" in
          POSTGRES_PASSWORD) echo "    POSTGRES_PASSWORD=postgres" ;;
          S3_ACCESS_KEY) echo "    S3_ACCESS_KEY=minio" ;;
          S3_SECRET_KEY) echo "    S3_SECRET_KEY=minio12345" ;;
          *) echo "    $ceo_v=<value>" ;;
        esac
      done
    else
      echo "  docker compose config said:"
      printf '%s\n' "$ceo_err" | tail -n 5 | sed 's/^/    /'
    fi
  } >> "$SIG/update.log"
  return 1
}

# refresh_one <box-file> <release-path> — extract one canonical compose from
# the (already pulled) target image and swap it in when the box copy is
# pristine. Echoes the outcome token. Never blocks the update.
refresh_one() {
  file="$1"; rel="$2"
  incoming="$STACK/.compose-incoming.tmp"
  rm -f "$incoming"
  cid=$(docker create "$IMG" 2>> "$SIG/update.log") || { echo extract-failed; return; }
  docker cp "$cid:$rel" "$incoming" >> "$SIG/update.log" 2>&1
  docker rm "$cid" > /dev/null 2>&1
  if [ ! -s "$incoming" ]; then
    rm -f "$incoming"; echo unavailable; return
  fi
  if [ ! -f "$STACK/$file.release" ]; then
    rm -f "$incoming"; echo no-baseline; return
  fi
  if cmp -s "$STACK/$file" "$STACK/$file.release"; then
    if ! compose_env_ok "$file" "$incoming"; then
      rm -f "$incoming"; echo incompatible-env; return
    fi
    if cp "$STACK/$file" "$STACK/$file.prev" \
      && cp "$incoming" "$STACK/.compose-release.tmp" \
      && mv "$STACK/.compose-release.tmp" "$STACK/$file.release" \
      && mv "$incoming" "$STACK/$file"; then
      echo refreshed
    else
      rm -f "$incoming" "$STACK/.compose-release.tmp"; echo write-failed
    fi
  else
    rm -f "$incoming"; echo modified
  fi
}

# refresh_compose <tag> — refresh BOTH release-owned compose files (server +
# client) from the target server image. The client file is optional: a
# server-only box (file absent) skips it. Sets REFRESH / CLIENT_REFRESH.
refresh_compose() {
  ns=$(sed -n 's/^MANTLE_IMAGE_NAMESPACE=//p' "$STACK/.env" 2>/dev/null | head -1)
  IMG="${ns:-titanwest}/mantle-server:$1"
  echo "[updater] compose refresh: reading canonicals from $IMG" | tee -a "$SIG/update.log"
  if ! docker pull "$IMG" >> "$SIG/update.log" 2>&1; then
    REFRESH=pull-failed; CLIENT_REFRESH=pull-failed
    echo "[updater] compose refresh skipped: could not pull $IMG" | tee -a "$SIG/update.log"
    return
  fi
  REFRESH=$(refresh_one docker-compose.yml /app/release/docker-compose.yml)
  case "$REFRESH" in
    refreshed) echo "[updater] server compose refreshed to the $1 canonical" | tee -a "$SIG/update.log" ;;
    unavailable) echo "[updater] compose refresh skipped: $IMG ships no embedded canonical" | tee -a "$SIG/update.log" ;;
    no-baseline) echo "[updater] ⚠ SERVER COMPOSE NOT REFRESHED: no baseline (pre-adoption box)." \
         "Run once from the stack dir: sudo sh scripts/compose-adopt.sh --apply" \
         "(sudo: a roll leaves root-owned files in the stack dir). Continuing on the EXISTING compose." | tee -a "$SIG/update.log" ;;
    incompatible-env) echo "[updater] ⚠ SERVER COMPOSE NOT REFRESHED: .env lacks variables the $1 compose requires (listed above)." \
         "Add them to .env, then request the update again. Continuing on the EXISTING compose." | tee -a "$SIG/update.log" ;;
    modified) echo "[updater] ⚠ SERVER COMPOSE NOT REFRESHED: docker-compose.yml has LOCAL EDITS." \
         "Move customization to docker-compose.override.yml + .env, then re-run scripts/compose-adopt.sh." \
         "Release-level compose changes are MISSING on this box." | tee -a "$SIG/update.log" ;;
    write-failed) echo "[updater] ⚠ server compose refresh FAILED writing files" | tee -a "$SIG/update.log" ;;
  esac
  # Client stack (v0.200+): only on boxes that RUN it (file present).
  if [ -f "$STACK/docker-compose.client.yml" ]; then
    CLIENT_REFRESH=$(refresh_one docker-compose.client.yml /app/release/docker-compose.client.yml)
    echo "[updater] client compose refresh: $CLIENT_REFRESH" | tee -a "$SIG/update.log"
  else
    CLIENT_REFRESH=absent
  fi
  # Core override (brain-core shape, v0.231+): only on boxes whose bundle
  # shipped it (file present). Refreshing it here is what keeps a core box's
  # service split current with releases: when a release adds a worker that a
  # core should NOT run, the gate arrives in the same roll. Inert on full
  # boxes (the file is only loaded when .env COMPOSE_FILE names it).
  if [ -f "$STACK/docker-compose.core.yml" ]; then
    CORE_REFRESH=$(refresh_one docker-compose.core.yml /app/release/docker-compose.core.yml)
    echo "[updater] core compose refresh: $CORE_REFRESH" | tee -a "$SIG/update.log"
  else
    CORE_REFRESH=absent
  fi
}

# ── front door: Caddyfile + shapes are release-owned too ─────────────────────
# Same pristine-vs-baseline rule as compose, same image, same roll. A box copy
# that matches its .release baseline is swapped for the target release's; a
# hand-edited copy is left alone and reported (routes a box needs belong in
# infra/caddy/conf.d/, which this never touches). Shape files that do not
# exist on the box yet are installed outright: they are new in v0.232.126 and
# the Caddyfile imports them, so a missing shape would be a broken front door.
# Any refreshed file means caddy must be RECREATED (a bind mount keeps the old
# inode); the roll below does that when CADDY_REFRESH says so.

# refresh_file <box-file> <release-path> <adopt-if-absent>: like refresh_one
# but for any release-owned file; the third arg installs a file the box does
# not have yet (echoes 'adopted').
refresh_file() {
  file="$1"; rel="$2"; adopt="$3"
  incoming="$STACK/.release-incoming.tmp"
  rm -f "$incoming"
  cid=$(docker create "$IMG" 2>> "$SIG/update.log") || { echo extract-failed; return; }
  docker cp "$cid:$rel" "$incoming" >> "$SIG/update.log" 2>&1
  docker rm "$cid" > /dev/null 2>&1
  if [ ! -s "$incoming" ]; then
    rm -f "$incoming"; echo unavailable; return
  fi
  if [ ! -f "$STACK/$file" ]; then
    if [ "$adopt" = yes ] && mkdir -p "$(dirname "$STACK/$file")" \
      && cp "$incoming" "$STACK/$file.release" && mv "$incoming" "$STACK/$file"; then
      echo adopted
    else
      rm -f "$incoming"; echo absent
    fi
    return
  fi
  if cmp -s "$STACK/$file" "$incoming"; then
    # Already this release's copy: make sure the baseline says so.
    [ -f "$STACK/$file.release" ] || cp "$incoming" "$STACK/$file.release"
    rm -f "$incoming"; echo current; return
  fi
  if [ ! -f "$STACK/$file.release" ]; then
    rm -f "$incoming"; echo no-baseline; return
  fi
  if cmp -s "$STACK/$file" "$STACK/$file.release"; then
    if cp "$STACK/$file" "$STACK/$file.prev" \
      && cp "$incoming" "$STACK/$file.release.tmp" \
      && mv "$STACK/$file.release.tmp" "$STACK/$file.release" \
      && mv "$incoming" "$STACK/$file"; then
      echo refreshed
    else
      rm -f "$incoming" "$STACK/$file.release.tmp"; echo write-failed
    fi
  else
    rm -f "$incoming"; echo modified
  fi
}

# refresh_caddy: every shipped shape FIRST, then the Caddyfile that imports
# them. Sets CADDY_REFRESH to the Caddyfile's outcome (or 'refreshed' when
# only a shape changed) for stack.json, and CADDY_RECREATE=1 when ANY of the
# files changed, so the roll forces a caddy recreate even when the Caddyfile
# itself is modified or has no baseline: a hand-edited Caddyfile that still
# imports the shapes would otherwise run a release routing change only after
# somebody restarted caddy by hand. Shapes first because the Caddyfile
# imports them by name: a Caddyfile installed without its shape crash-loops
# caddy and takes the site down (compose-adopt.sh learned this on
# 2026-09-02; the updater used to do it the other way round). If a shape the
# box needs is missing after the loop, the Caddyfile is left alone. Requires
# IMG (set by refresh_compose).
refresh_caddy() {
  CADDY_RECREATE=""
  shapes_ok=1
  for shape in same-origin split; do
    r=$(refresh_file "$CADDY_SHAPES_REL/$shape.caddy" "/app/release/caddy-shapes/$shape.caddy" yes)
    case "$r" in
      refreshed|adopted)
        echo "[updater] caddy shape $shape $r" | tee -a "$SIG/update.log"
        CADDY_RECREATE=1 ;;
      current) : ;;
      *)
        echo "[updater] ⚠ caddy shape $shape: $r" | tee -a "$SIG/update.log"
        # modified / no-baseline shapes still exist and satisfy the import;
        # only a shape that is NOT on disk blocks the Caddyfile.
        [ -s "$STACK/$CADDY_SHAPES_REL/$shape.caddy" ] || shapes_ok=0 ;;
    esac
  done
  if [ "$shapes_ok" != 1 ]; then
    CADDY_REFRESH=shape-failed
    echo "[updater] ⚠ CADDYFILE NOT REFRESHED: a shape it imports is missing and could not be installed (see above)." \
         "A Caddyfile without its shape crash-loops caddy. Continuing on the EXISTING Caddyfile." | tee -a "$SIG/update.log"
    return
  fi
  CADDY_REFRESH=$(refresh_file "$CADDY_REL" /app/release/Caddyfile no)
  case "$CADDY_REFRESH" in
    refreshed) CADDY_RECREATE=1; echo "[updater] Caddyfile refreshed to the $1 canonical" | tee -a "$SIG/update.log" ;;
    current) [ -z "$CADDY_RECREATE" ] || CADDY_REFRESH=refreshed ;;
    unavailable) echo "[updater] Caddyfile refresh skipped: image ships no /app/release/Caddyfile" | tee -a "$SIG/update.log" ;;
    no-baseline) echo "[updater] ⚠ CADDYFILE NOT REFRESHED: no baseline (pre-adoption box). To adopt the release front door:" \
         "1) set MANTLE_CADDY_SHAPE in .env (same-origin, the default: one domain routes both apps; split: owner UI on its own hostname);" \
         "2) from the stack dir: sudo sh scripts/compose-adopt.sh --apply (sudo: the roll left root-owned files in infra/caddy);" \
         "3) docker compose up -d --no-deps --force-recreate caddy. Continuing on the EXISTING Caddyfile." | tee -a "$SIG/update.log" ;;
    modified) echo "[updater] ⚠ CADDYFILE NOT REFRESHED: $CADDY_REL has LOCAL EDITS." \
         "Move box routes to infra/caddy/conf.d/*.caddy, then re-run: sudo sh scripts/compose-adopt.sh --apply" \
         "Release-level front-door changes are MISSING on this box." | tee -a "$SIG/update.log" ;;
    *) echo "[updater] ⚠ Caddyfile refresh: $CADDY_REFRESH" | tee -a "$SIG/update.log" ;;
  esac
}

# ── operator scripts: release-owned too ──────────────────────────────────────
# db-dump, db-restore, sanity, compose-adopt, uninstall and the install.sh
# configurator. Nothing refreshed these before v0.232.137, so a box ran the
# copies install.sh fetched on the day it was built, forever. jason-prod paid
# for it: a 2026-07-25 compose-adopt.sh applied a compose that binds
# infra/caddy/{shapes,conf.d} while knowing nothing about either, so neither
# directory was created and no Caddyfile baseline was written — the next
# `up -d` would have had Docker create both as root-owned strays inside a
# cwe-owned tree, with the front door still on the stale Caddyfile.
#
# ONE difference from every other release-owned file: a missing baseline
# ADOPTS instead of reporting. For compose and the Caddyfile a no-baseline box
# is left alone because its copy may carry box-local routes worth more than the
# refresh. That reasoning does not transfer here. These are release TOOLING —
# conf.d and docker-compose.override.yml exist so box-local behaviour never
# lives in a release-owned file — and the pre-adoption state is not neutral, it
# is provably harmful. Refusing would leave the whole fleet stale exactly as it
# is today, waiting on a manual step per box that is the thing that never
# happens. The previous copy is kept as <name>.pre-adopt.<utc> so an operator
# edit is recoverable, and the source is the image this box already runs.
# keep_newest <prefix> <n>: delete all but the newest <n> files named
# <prefix>*. The suffix is a UTC stamp, so lexical order is time order.
keep_newest() {
  ls -1d "$1"* 2>/dev/null | sort -r | tail -n +"$(($2 + 1))" | while IFS= read -r kn_f; do
    rm -f "$kn_f"
  done
}

refresh_scripts() {
  rsd="$STACK/.release-scripts.tmp"
  rm -rf "$rsd"
  cid=$(docker create "$IMG" 2>> "$SIG/update.log") || { SCRIPTS_REFRESH=extract-failed; return; }
  # One extraction for the whole set: six docker cp round-trips per roll is
  # six container filesystems mounted for no reason.
  docker cp "$cid:/app/release/scripts" "$rsd" >> "$SIG/update.log" 2>&1
  docker rm "$cid" > /dev/null 2>&1
  if [ ! -d "$rsd" ]; then
    rm -rf "$rsd"
    SCRIPTS_REFRESH=unavailable
    echo "[updater] operator scripts: image ships no /app/release/scripts (pre-v0.232.137)" \
      | tee -a "$SIG/update.log"
    return
  fi

  changed=0; kept=0; missing=0
  mkdir -p "$STACK/$SCRIPTS_REL"
  for n in $SCRIPT_NAMES; do
    src="$rsd/$n"
    dst="$STACK/$SCRIPTS_REL/$n"
    [ -f "$src" ] || { missing=$((missing + 1)); continue; }
    if [ -f "$dst" ] && cmp -s "$dst" "$src"; then
      # Already this release's copy — make sure the baseline agrees, so the
      # NEXT release takes the pristine path rather than adopting again.
      [ -f "$dst.release" ] || cp "$src" "$dst.release"
      continue
    fi
    if [ -f "$dst" ] && [ -f "$dst.release" ] && ! cmp -s "$dst" "$dst.release"; then
      # Hand-edited against a baseline that proves it: never overwrite.
      kept=$((kept + 1))
      echo "[updater] ⚠ scripts/$n NOT REFRESHED: local edits. Release-level" \
        "changes to it are MISSING on this box." | tee -a "$SIG/update.log"
      continue
    fi
    if [ -f "$dst" ]; then
      cp "$dst" "$dst.pre-adopt.$(date -u +%Y%m%d-%H%M%S)"
      # A pristine refresh writes one of these too, per changed script per
      # roll; on daily releases that was hundreds of files nobody pruned.
      # Three per script is plenty to recover an operator edit from.
      keep_newest "$dst.pre-adopt." 3
    fi
    if cp "$src" "$dst.tmp" && mv "$dst.tmp" "$dst" && cp "$src" "$dst.release"; then
      # docker cp carries the mode, plain cp does not reliably — and a
      # non-executable db-restore.sh is a script an operator finds at 3am.
      chmod +x "$dst"
      changed=$((changed + 1))
    else
      rm -f "$dst.tmp"
      kept=$((kept + 1))
      echo "[updater] ⚠ scripts/$n: write failed" | tee -a "$SIG/update.log"
    fi
  done
  rm -rf "$rsd"

  [ "$missing" -gt 0 ] && echo "[updater] ⚠ $missing operator script(s) absent from the image" \
    | tee -a "$SIG/update.log"
  if [ "$changed" -gt 0 ]; then
    SCRIPTS_REFRESH=refreshed
    echo "[updater] operator scripts refreshed to the $1 canonical ($changed changed)" \
      | tee -a "$SIG/update.log"
  elif [ "$kept" -gt 0 ]; then
    SCRIPTS_REFRESH=modified
  else
    SCRIPTS_REFRESH=current
  fi
}

# ── release pair: which owner-UI tag rides with a server roll ────────────────
# Since the repo split the client image versions on its OWN stream (built by
# the jackdaw repo). Each server image embeds the client tag it was released
# against at /app/release/client-tag; a server roll moves the client to that
# tag so the pair a user runs is always one that was tested together.

# ── .env writes: keep the operator's ownership and mode ──────────────────────
# This sidecar runs as root with umask 022. A bare `sed > tmp && mv` swapped
# the operator's 0600 .env for a root:root 0644 one: the master key readable
# by every user on the host, and the next unprivileged scripts/install.sh
# re-run dying on its first `touch`. Every rewrite now goes through
# env_rewrite: the temp file is created under umask 077 in the same
# directory, then given the owner and mode of the file it replaces (0600
# when there is nothing to copy them from), then moved over it.
# stat: busybox and GNU take -c, BSD takes -f; both are tried so the same
# code runs in the sidecar (alpine) and in the harness on a Mac.
file_owner() { stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1" 2>/dev/null; }
file_mode()  { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }

# env_rewrite <sed-expression>: rewrite $STACK/.env through sed, preserving
# owner and mode. Non-zero (and .env untouched) on failure.
env_rewrite() {
  er_tmp="$STACK/.env.updater-tmp"
  er_own=$(file_owner "$STACK/.env"); er_mode=$(file_mode "$STACK/.env")
  rm -f "$er_tmp"
  ( umask 077; sed "$1" "$STACK/.env" > "$er_tmp" ) || { rm -f "$er_tmp"; return 1; }
  chmod "${er_mode:-600}" "$er_tmp" 2>/dev/null || chmod 600 "$er_tmp"
  [ -z "$er_own" ] || chown "$er_own" "$er_tmp" 2>/dev/null
  mv "$er_tmp" "$STACK/.env"
}

# persist_env <name> <value> — upsert one var in $STACK/.env. Temp-file
# rewrite, not `sed -i` (busybox/BSD flag drift). Values reach here only via
# the tag whitelist, so the sed pattern needs no escaping.
persist_env() {
  if grep -q "^$1=" "$STACK/.env" 2>/dev/null; then
    env_rewrite "s|^$1=.*|$1=$2|"
  else
    ( umask 077; printf '\n%s=%s\n' "$1" "$2" >> "$STACK/.env" )
  fi
}

# read_paired_tag — the embedded client tag of $IMG (already pulled). Empty on
# pre-pair images or extraction failure; sanitized against the tag whitelist
# because it feeds persist_env and a compose pull.
read_paired_tag() {
  rpt_out="$SIG/.client-tag.tmp"; rm -f "$rpt_out"
  rpt_cid=$(docker create "$IMG" 2>> "$SIG/update.log") || return 0
  docker cp "$rpt_cid:/app/release/client-tag" "$rpt_out" >> "$SIG/update.log" 2>&1
  docker rm "$rpt_cid" > /dev/null 2>&1
  rpt_tag=$(head -1 "$rpt_out" 2>/dev/null | tr -d ' \r\n'); rm -f "$rpt_out"
  case "$rpt_tag" in *[!A-Za-z0-9._-]*) rpt_tag="" ;; esac
  printf '%s' "$rpt_tag"
}

# resolve_client_tag — pick the tag for this roll's client stack and persist
# it. Sets CLIENT_ROLL_TAG ("" = leave the box's current behaviour alone).
#
# Precedence: an explicit client_target in the request wins; otherwise a USER
# pin in .env is honoured and left untouched; otherwise the target image's
# paired tag. "User pin" is detected by comparison with /signal/client-tag.auto
# — the last value THIS script wrote. A value we wrote is ours to manage; a
# value we didn't is the owner holding the UI still, which pairing must not
# steamroll. Chosen values are persisted to .env (so a later manual
# `docker compose up` doesn't fall back to :latest and roll the UI by
# accident) and recorded in client-tag.auto.
resolve_client_tag() {
  CLIENT_ROLL_TAG=""
  rct_env=$(sed -n 's/^MANTLE_CLIENT_IMAGE_TAG=//p' "$STACK/.env" 2>/dev/null | head -1)
  rct_auto=$(head -1 "$SIG/client-tag.auto" 2>/dev/null | tr -d ' \r\n')
  if [ -n "$CLIENT_TARGET" ]; then
    CLIENT_ROLL_TAG="$CLIENT_TARGET"
    echo "[updater] client tag: $CLIENT_ROLL_TAG (requested)" | tee -a "$SIG/update.log"
  elif [ -n "$rct_env" ] && [ "$rct_env" != "$rct_auto" ]; then
    echo "[updater] client tag: $rct_env (pinned in .env — leaving it)" | tee -a "$SIG/update.log"
    return
  else
    CLIENT_ROLL_TAG=$(read_paired_tag)
    if [ -n "$CLIENT_ROLL_TAG" ]; then
      echo "[updater] client tag: $CLIENT_ROLL_TAG (paired with $TARGET)" | tee -a "$SIG/update.log"
    else
      echo "[updater] client tag: no pair file in the target image — keeping current behaviour" | tee -a "$SIG/update.log"
      return
    fi
  fi
  persist_env MANTLE_CLIENT_IMAGE_TAG "$CLIENT_ROLL_TAG"
  printf '%s\n' "$CLIENT_ROLL_TAG" > "$SIG/client-tag.auto"
}

# ── release-owned updater: self-refresh ──────────────────────────────────────
# THIS SCRIPT is bind-mounted from the box and was, until v0.206, the one
# release-owned file nothing ever refreshed. A box whose infra/ predated a
# script change ran the old logic forever while everything updated around it —
# and because the stale copy still reported ok:true, the failure was SILENT.
# Found live on dev 2026-07-26: every box in the fleet carried a pre-v0.200
# script, so in-app updates rolled the server stack and skipped the CLIENT
# stack without a word. Fixed by hand then; this closes it durably.
#
# Three things make this different from the compose refresh:
#
#  1. IT CANNOT REPLACE ITSELF MID-RUN. busybox sh reads a script
#     incrementally, so overwriting the file underneath a running shell can
#     make it resume at a byte offset in the NEW text. So the swap is the last
#     act of a SUCCESSFUL run, after status.json/stack.json are final, and the
#     new copy is entered with a clean `exec` rather than fall-through.
#  2. THE ENTRYPOINT MOUNT IS AN INODE, NOT A PATH. `up` mounts this file at
#     /updater.sh; an atomic `mv` swaps the stack-dir file for a NEW inode, and
#     /updater.sh keeps resolving to the OLD one for the life of the container.
#     Re-exec therefore MUST go through the stack-dir mount ($STACK/$UPDATER_REL,
#     a directory mount that resolves per-path), never /updater.sh — which would
#     silently re-enter the very copy we just replaced.
#  3. A BAD SWAP BRICKS THE SIDECAR. A syntax error here is not a degraded
#     update, it is a container that crash-loops with no way to ask for the next
#     one. Hence `sh -n` on the incoming file BEFORE it is installed.
#
# Unlike compose there is no `no-baseline` standoff: docker-compose.yml has a
# supported box-local dialect (install.sh writes it, overrides merge into it),
# but this script takes ALL of its box-specific input from the environment and
# has no supported local variation — so on a box with no baseline yet, every
# difference IS the staleness this exists to fix. It adopts: baseline seeded,
# canonical installed, previous copy kept as .prev. A copy that differs from an
# EXISTING baseline is still refused and reported, same as compose.
refresh_updater() {
  incoming="$STACK/.updater-incoming.tmp"
  rm -f "$incoming"
  cid=$(docker create "$IMG" 2>> "$SIG/update.log") || { echo extract-failed; return; }
  docker cp "$cid:/app/release/updater.sh" "$incoming" >> "$SIG/update.log" 2>&1
  docker rm "$cid" > /dev/null 2>&1
  # Pre-v0.206 images ship no embedded updater.sh — nothing to refresh from.
  if [ ! -s "$incoming" ]; then
    rm -f "$incoming"; echo unavailable; return
  fi
  # Never install something we cannot prove is a runnable script.
  if ! head -1 "$incoming" | grep -q '^#!'; then
    rm -f "$incoming"; echo not-a-script; return
  fi
  if ! sh -n "$incoming" 2>> "$SIG/update.log"; then
    rm -f "$incoming"; echo syntax-error; return
  fi
  # Already current — the common case on every run after the first. Seize the
  # chance to seed a missing baseline: the box copy has just been PROVEN
  # identical to the canonical, so recording it costs nothing and upgrades
  # every later refresh from "adopt" to the strict pristine check below —
  # which is what makes a hand-edit detectable instead of silently overwritten.
  if cmp -s "$STACK/$UPDATER_REL" "$incoming"; then
    if [ ! -f "$STACK/$UPDATER_REL.release" ]; then
      cp "$incoming" "$STACK/.updater-release.tmp" \
        && mv "$STACK/.updater-release.tmp" "$STACK/$UPDATER_REL.release"
    fi
    rm -f "$incoming"; echo current; return
  fi
  if [ -f "$STACK/$UPDATER_REL.release" ] \
    && ! cmp -s "$STACK/$UPDATER_REL" "$STACK/$UPDATER_REL.release"; then
    rm -f "$incoming"; echo modified; return
  fi
  adopted=adopted
  [ -f "$STACK/$UPDATER_REL.release" ] && adopted=refreshed
  if cp "$STACK/$UPDATER_REL" "$STACK/$UPDATER_REL.prev" \
    && cp "$incoming" "$STACK/.updater-release.tmp" \
    && mv "$STACK/.updater-release.tmp" "$STACK/$UPDATER_REL.release" \
    && mv "$incoming" "$STACK/$UPDATER_REL"; then
    echo "$adopted"
  else
    rm -f "$incoming" "$STACK/.updater-release.tmp"; echo write-failed
  fi
}

# ── pre-roll backup: no roll without a way back ──────────────────────────────
# Any admin can request a roll from /settings/updates, and a roll runs
# forward-only migrations (0177 and 0178 drop tables). Before this step the
# standard path took no backup at all: a dump happened only when the operator
# remembered one. So every server roll now starts with the box's own
# scripts/db-dump.sh, all four parts (Postgres, app-dbs, table-dbs, spaces),
# in strict mode, into backups/pre-roll/ under the stack dir. It runs BEFORE
# anything else in the roll: before the MANTLE_IMAGE_TAG write, the compose,
# Caddyfile and script refreshes, the pull and the up. When it fails, or the
# disk is too full for it, the roll is refused with nothing changed and the
# reason in status.json. The interface-only path (client_target alone) runs no
# migration and touches no data, so it takes no backup.
#
# .env knobs (the operator's, never the request's):
#   MANTLE_PRE_ROLL_BACKUP=0        skip it (loudly). For a box whose disk
#                                   cannot hold one; take your own first.
#   MANTLE_PRE_ROLL_KEEP=3          complete sets kept in backups/pre-roll
#   MANTLE_PRE_ROLL_MIN_FREE_MB=4096 headroom on top of the backup estimate
#                                   (the pull that follows needs room too)
#
# The sidecar has busybox sh and no bash; db-dump.sh is kept POSIX for this.
# Container names are passed explicitly: compose pins them, and db-dump's own
# guess refuses to pick when a dev stack runs beside the box's.
PRE_ROLL_REL=backups/pre-roll
PRB_ERR=""

# env_val <name>: the value of <name> in $STACK/.env ("" when unset).
env_val() { sed -n "s/^$1=//p" "$STACK/.env" 2>/dev/null | head -1 | tr -d '\r'; }

# num_or <value> <default>: <value> when it is a whole number, else <default>.
num_or() { case "$1" in '' | *[!0-9]*) printf '%s' "$2" ;; *) printf '%s' "$1" ;; esac; }

# free_kb <dir>: free KB on the filesystem holding <dir>.
free_kb() { df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'; }

# db_size_kb: the live database size in KB, the estimate for a first backup
# (a -Fc dump is smaller: indexes are not dumped and the data is compressed).
db_size_kb() {
  dsk=$(docker exec mantle_pg psql -U postgres -d postgres -Atc \
    "select pg_database_size('postgres') / 1024" 2>/dev/null | tr -d ' \r')
  num_or "$dsk" ""
}

# set_files <dir> <stamp>: the files of one backup set that exist.
set_files() {
  for sf in "$1/mantle-$2.dump" "$1/mantle-app-dbs-$2.tgz" \
    "$1/mantle-table-dbs-$2.tgz" "$1/mantle-spaces-$2.tgz"; do
    [ -f "$sf" ] && printf '%s\n' "$sf"
  done
}

# newest_set_kb <dir>: size in KB of the newest backup set ("" when none).
# The names below are ours (mantle-<stamp>.<ext>), so ls is safe here.
newest_set_kb() {
  # shellcheck disable=SC2012
  nsk_dump=$(ls -1 "$1"/mantle-*.dump 2>/dev/null | sort -r | head -1)
  [ -n "$nsk_dump" ] || return 0
  nsk_ts=${nsk_dump##*/mantle-}; nsk_ts=${nsk_ts%.dump}
  set_files "$1" "$nsk_ts" | while IFS= read -r nsk_f; do du -k "$nsk_f" | cut -f1; done \
    | awk '{ s += $1 } END { print s + 0 }'
}

# prune_pre_roll <dir> <keep>: delete all but the newest <keep> backup sets.
# A set is the .dump plus the three archives with the same stamp; the stamp is
# %Y%m%d-%H%M%S, so lexical order is time order. Only this directory is ever
# pruned: backups/ itself holds the operator's own dumps and is never touched.
prune_pre_roll() {
  # shellcheck disable=SC2012
  ls -1 "$1"/mantle-*.dump 2>/dev/null | sort -r | tail -n +"$(($2 + 1))" | while IFS= read -r ppr_dump; do
    ppr_ts=${ppr_dump##*/mantle-}; ppr_ts=${ppr_ts%.dump}
    set_files "$1" "$ppr_ts" | while IFS= read -r ppr_f; do rm -f "$ppr_f"; done
    echo "[updater] pre-roll backup $ppr_ts removed (keeping the newest $2)"
  done
}

# pre_roll_backup: 0 when a complete backup set was written (or the box opted
# out), non-zero with PRB_ERR set otherwise. On failure every file this run
# wrote is removed again, so a half set never passes for a backup.
pre_roll_backup() {
  PRB_ERR=""
  if [ "$(env_val MANTLE_PRE_ROLL_BACKUP)" = 0 ]; then
    echo "[updater] ⚠ PRE-ROLL BACKUP SKIPPED: MANTLE_PRE_ROLL_BACKUP=0 in .env." \
      "This roll's only way back is a backup you took yourself." | tee -a "$SIG/update.log"
    return 0
  fi
  prb_dir="$STACK/$PRE_ROLL_REL"
  prb_script="$STACK/scripts/db-dump.sh"
  if [ ! -f "$prb_script" ]; then
    PRB_ERR="scripts/db-dump.sh is missing from the stack dir"; return 1
  fi
  prb_own=$(file_owner "$STACK")
  prb_new_parent=""
  [ -d "$STACK/backups" ] || prb_new_parent=1
  if ! mkdir -p "$prb_dir"; then
    PRB_ERR="cannot create $PRE_ROLL_REL in the stack dir"; return 1
  fi
  # A backups/ this root sidecar just created must still take the operator's
  # own `bash scripts/db-dump.sh`, which writes there as the stack owner.
  if [ -n "$prb_new_parent" ] && [ -n "$prb_own" ]; then
    chown "$prb_own" "$STACK/backups" 2>/dev/null
  fi

  # Room for it? The estimate is the last pre-roll set (the best predictor of
  # the next one) or, the first time, the live database size. Half again on
  # top for growth, plus the headroom the image pull needs after it.
  prb_est=$(newest_set_kb "$prb_dir"); prb_basis="the last pre-roll backup"
  if [ -z "$prb_est" ] || [ "$prb_est" = 0 ]; then
    prb_est=$(db_size_kb); prb_basis="the database size"
  fi
  prb_est=$(num_or "$prb_est" 0)
  prb_floor=$(num_or "$(env_val MANTLE_PRE_ROLL_MIN_FREE_MB)" 4096)
  prb_need=$((prb_est + prb_est / 2 + prb_floor * 1024))
  prb_free=$(num_or "$(free_kb "$prb_dir")" "")
  if [ -z "$prb_free" ]; then
    PRB_ERR="cannot read the free disk space under $PRE_ROLL_REL"; return 1
  fi
  if [ "$prb_free" -lt "$prb_need" ]; then
    PRB_ERR="not enough disk for the pre-roll backup: $((prb_free / 1024)) MB free, need $((prb_need / 1024)) MB (1.5 x $prb_basis + ${prb_floor} MB headroom). Free space (old images, old backups) and request again"
    return 1
  fi

  echo "[updater] pre-roll backup → $PRE_ROLL_REL (postgres, app-dbs, table-dbs, spaces;" \
    "$((prb_free / 1024)) MB free, estimate $((prb_est / 1024)) MB)" | tee -a "$SIG/update.log"
  prb_before="$SIG/.pre-roll-before.tmp"
  ls -1 "$prb_dir" > "$prb_before" 2>/dev/null
  # umask 077: a whole-brain dump is not for every user on the host.
  ( umask 077; MANTLE_DUMP_DIR="$prb_dir" MANTLE_DUMP_STRICT=1 \
      MANTLE_PG_CONTAINER=mantle_pg MANTLE_APP_CONTAINER=mantle_web \
      sh "$prb_script" ) >> "$SIG/update.log" 2>&1
  prb_rc=$?
  # An empty pattern file is not portable across greps: no earlier files
  # means every file is new.
  if [ -s "$prb_before" ]; then
    # shellcheck disable=SC2010
    prb_new=$(ls -1 "$prb_dir" 2>/dev/null | grep -vxF -f "$prb_before")
  else
    prb_new=$(ls -1 "$prb_dir" 2>/dev/null)
  fi
  rm -f "$prb_before"
  if [ "$prb_rc" -ne 0 ]; then
    PRB_ERR="db-dump.sh failed (exit $prb_rc), see update.log"
  elif ! printf '%s\n' "$prb_new" | grep -q '^mantle-.*\.dump$'; then
    # Exit 0 with no dump here: a db-dump.sh too old (or hand-edited) to know
    # MANTLE_DUMP_DIR wrote its set somewhere else, and not strictly.
    PRB_ERR="db-dump.sh wrote no Postgres dump into $PRE_ROLL_REL (a stale or edited scripts/db-dump.sh?)"
  fi
  if [ -n "$PRB_ERR" ]; then
    printf '%s\n' "$prb_new" | while IFS= read -r prb_f; do
      [ -n "$prb_f" ] && rm -f "$prb_dir/$prb_f"
    done
    return 1
  fi

  # Hand the set to the stack dir's owner (this sidecar is root): the operator
  # restores and deletes these, and must be able to without sudo.
  [ -z "$prb_own" ] || chown -R "$prb_own" "$prb_dir" 2>/dev/null
  # shellcheck disable=SC2086  # one line listing the set is the point
  echo "[updater] pre-roll backup ok:" $prb_new | tee -a "$SIG/update.log"
  prune_pre_roll "$prb_dir" "$(num_or "$(env_val MANTLE_PRE_ROLL_KEEP)" 3)" | tee -a "$SIG/update.log"
  return 0
}

# ── rollback floor: client logins ────────────────────────────────────────────
# v0.232.317 and older treat every login that is not a member as an admin
# (client logins C0 made the role check fail closed in v0.232.318). Once a
# client login exists, rolling the image below that floor would let each
# client sign in as an admin: the cookie is the same, the row is the same.
# So a request for a release below the floor is refused, with nothing
# changed, while auth.users holds any client login. The updater that decides
# is the one running now (the box's), not the target's. `latest` and tags
# that are not a release version (vX.Y.Z) are never refused here.
#
# .env knob (the operator's, never the request's):
#   MANTLE_ALLOW_BELOW_CLIENT_FLOOR=1  roll anyway (loudly). Only for a box
#                                      whose client logins you have removed
#                                      or restored away yourself.
CLIENT_FLOOR=0.232.318
CFR_ERR=""

# tag_below <tag> <x.y.z>: 0 when <tag> is a release version (vX.Y.Z or
# X.Y.Z) older than <x.y.z>; 1 for anything else, `latest` included.
tag_below() {
  tb_v=${1#v}
  case "$tb_v" in *.*.*.* | *[!0-9.]* | .* | *. | *..*) return 1 ;; *.*.*) ;; *) return 1 ;; esac
  tb_f=$2
  tb_i=0
  while [ "$tb_i" -lt 3 ]; do
    tb_x=${tb_v%%.*}; tb_y=${tb_f%%.*}
    [ "$tb_x" -lt "$tb_y" ] && return 0
    [ "$tb_x" -gt "$tb_y" ] && return 1
    tb_v=${tb_v#*.}; tb_f=${tb_f#*.}
    tb_i=$((tb_i + 1))
  done
  return 1
}

# client_logins_count: the number of client logins ("" when Postgres cannot
# be read). to_jsonb keeps it valid on a schema from before the role column.
client_logins_count() {
  clc=$(docker exec mantle_pg psql -U postgres -d postgres -Atc \
    "select count(*) from auth.users u where to_jsonb(u)->>'role' = 'client'" 2>/dev/null | tr -d ' \r')
  num_or "$clc" ""
}

# client_floor_refusal <tag>: 0 with CFR_ERR set when the roll must be
# refused; 1 when it may go ahead. Fails closed: a target below the floor on
# a box whose logins cannot be counted is refused too.
client_floor_refusal() {
  CFR_ERR=""
  tag_below "$1" "$CLIENT_FLOOR" || return 1
  if [ "$(env_val MANTLE_ALLOW_BELOW_CLIENT_FLOOR)" = 1 ]; then
    echo "[updater] ⚠ ROLLING BELOW v$CLIENT_FLOOR: MANTLE_ALLOW_BELOW_CLIENT_FLOOR=1 in .env." \
      "Any client login on this box would sign in as an admin on $1." | tee -a "$SIG/update.log"
    return 1
  fi
  cfr_n=$(client_logins_count)
  if [ -z "$cfr_n" ]; then
    CFR_ERR="$1 is below v$CLIENT_FLOOR and the client logins could not be counted (is mantle_pg up?). Below that release every login that is not a member is an admin; see Rollback floors in docs/update-prod.md"
    return 0
  fi
  [ "$cfr_n" -gt 0 ] || return 1
  CFR_ERR="$1 is below v$CLIENT_FLOOR, the floor once any client login exists ($cfr_n here): older images treat every login that is not a member as an admin, so each client would sign in as an admin. Restore a backup from before the client logins instead (Rollback floors in docs/update-prod.md), or set MANTLE_ALLOW_BELOW_CLIENT_FLOOR=1 in .env"
  return 0
}

# ── image prune: this product's images only ──────────────────────────────────
# Nothing pruned images before this: each roll left a server + client pair
# (about 3.4 GB) behind, and boxes filled at eight releases a day (dev hit 100%
# on 2026-09-01). After an OK roll the updater removes old images of exactly
# two repositories, <ns>/mantle-server and <ns>/mantle-client, and keeps:
#   - the image each container ran BEFORE the roll (the rollback pair),
#   - the image each runs NOW,
#   - the two newest images of the repository (a pre-pulled next release, or
#     the previous pair when this roll re-rolled the same tag).
# It never touches any other repository (mantle-sandbox, mantle-rustfs, caddy,
# postgres, app or sandbox images), never volumes or containers, never runs a
# `system prune`, and never forces: `docker rmi` refuses an image a container
# still uses, and that refusal is logged and left alone. Off with
# MANTLE_IMAGE_PRUNE=0 in .env.

# container_image <name>: the full image id a container runs ("" when absent).
container_image() { docker inspect -f '{{.Image}}' "$1" 2>/dev/null; }

# prune_repo <repo> <prev-id> <cur-id>
prune_repo() {
  pr_repo=$1; pr_prev=$2; pr_cur=$3
  if [ -z "$pr_prev" ] || [ -z "$pr_cur" ]; then
    echo "[updater] image prune: $pr_repo skipped (the running image before or after the roll is unknown)"
    return 0
  fi
  pr_list=$(docker image ls --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}' "$pr_repo" 2>/dev/null) || return 0
  pr_newest=$(printf '%s\n' "$pr_list" | awk 'NF { print $1 }' | awk '!seen[$0]++' | head -2)
  printf '%s\n' "$pr_list" | while read -r pr_id pr_ref; do
    [ -n "$pr_id" ] && [ -n "$pr_ref" ] || continue
    # Exact repository only: the reference filter is exact already, this
    # makes it independent of how a docker version reads that filter.
    [ "${pr_ref%:*}" = "$pr_repo" ] || continue
    [ "$pr_id" = "$pr_prev" ] && continue
    [ "$pr_id" = "$pr_cur" ] && continue
    printf '%s\n' "$pr_newest" | grep -qxF "$pr_id" && continue
    case "$pr_ref" in
      *':<none>') pr_target=$pr_id ;;
      *) pr_target=$pr_ref ;;
    esac
    if docker rmi "$pr_target" > /dev/null 2>&1; then
      echo "[updater] image prune: removed $pr_ref"
    else
      echo "[updater] image prune: kept $pr_ref (docker refused to remove it; still in use?)"
    fi
  done
}

# prune_images <prev-server-id> <prev-client-id>: after an OK roll.
prune_images() {
  if [ "$(env_val MANTLE_IMAGE_PRUNE)" = 0 ]; then
    echo "[updater] image prune: off (MANTLE_IMAGE_PRUNE=0)" | tee -a "$SIG/update.log"
    return 0
  fi
  pi_ns=$(env_val MANTLE_IMAGE_NAMESPACE)
  prune_repo "${pi_ns:-titanwest}/mantle-server" "$1" "$(container_image mantle_web)" | tee -a "$SIG/update.log"
  prune_repo "${pi_ns:-titanwest}/mantle-client" "$2" "$(container_image mantle_client_web)" | tee -a "$SIG/update.log"
}

# topup_scripts: install an operator script the RUNNING release names but the
# box lacks. refresh_scripts runs inside the OLD updater with the OLD
# SCRIPT_NAMES, so a script a release ADDS (onboard.sh, 2026-10) would land one
# roll late: the swapped-in updater knows the name but never ran a refresh.
# Called once at startup (a fresh container, or the re-exec after a
# self-refresh, whichever copy did the exec), it reads the image the web
# container runs, which after a roll is the release just applied. A no-op
# unless a name is missing, so a restart costs one test per script.
topup_scripts() {
  tu_missing=""
  for n in $SCRIPT_NAMES; do
    [ -f "$STACK/$SCRIPTS_REL/$n" ] || tu_missing="$tu_missing $n"
  done
  [ -n "$tu_missing" ] || return 0
  tu_img=$(container_image mantle_web)
  [ -n "$tu_img" ] || return 0
  IMG="$tu_img"
  echo "[updater] operator scripts missing on this box:$tu_missing; reading them from the running web image" \
    | tee -a "$SIG/update.log"
  refresh_scripts running
}

# ── optional services: the brain's live capability source ────────────────────
# Sandboxes and media are compose PROFILES. Whether one is on is a fact about
# THIS box's .env, and the app containers cannot see .env: their env is what
# compose resolved when it created them, and a dashboard switch starts or
# stops ONE container without touching theirs. So this sidecar, which can see
# .env, publishes the state to /signal/services.json (every app service mounts
# /signal read-only) on boot, every ~5 min, after a roll and after a switch.
# @mantle/config services is the reader. The file carries key NAMES' presence
# only, never a value.
SERVICE_PROFILES="sandboxes media"
# Request kinds this updater understands; the UI offers a switch only when
# 'service' is listed.
UPDATER_VERBS='"roll","service"'

service_container() {
  case "$1" in sandboxes) echo mantle_sandboxd ;; media) echo mantle_media ;; esac
}
service_token_var() {
  case "$1" in sandboxes) echo SANDBOXD_TOKEN ;; media) echo MEDIA_SIDECAR_TOKEN ;; esac
}

# profiles_csv: the box's COMPOSE_PROFILES, whitespace and empty items dropped.
profiles_csv() {
  env_val COMPOSE_PROFILES | tr -d ' \t' | tr ',' '\n' | sed '/^$/d' | tr '\n' ',' | sed 's/,$//'
}
# profile_active <name>: the profile is in COMPOSE_PROFILES.
profile_active() { printf ',%s,' "$(profiles_csv)" | grep -q ",$1,"; }

# write_services_info: /signal/services.json, temp + rename so a reader never
# sees half a file.
write_services_info() {
  ws_profiles=$(profiles_csv | tr -cd 'A-Za-z0-9._,-')
  ws_body=""
  for ws_s in $SERVICE_PROFILES; do
    ws_p=false; profile_active "$ws_s" && ws_p=true
    ws_t=false; [ -z "$(env_val "$(service_token_var "$ws_s")")" ] || ws_t=true
    ws_state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      "$(service_container "$ws_s")" 2>/dev/null | head -1)
    ws_c=$(printf '%s' "${ws_state%% *}" | tr -cd 'a-z')
    ws_h=$(printf '%s' "${ws_state#* }" | tr -cd 'a-z')
    [ -n "$ws_c" ] || ws_c=absent
    [ -n "$ws_h" ] || ws_h=none
    ws_body="$ws_body${ws_body:+,}$(printf '"%s":{"profile":%s,"token":%s,"container":"%s","health":"%s"}' \
      "$ws_s" "$ws_p" "$ws_t" "$ws_c" "$ws_h")"
  done
  ws_mt=$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo 2>/dev/null)
  ws_ma=$(awk '/^MemAvailable:/ { print $2; exit }' /proc/meminfo 2>/dev/null)
  ws_df=$(free_kb "$STACK")
  ws_core=false
  case "$(env_val COMPOSE_FILE)" in *docker-compose.core.yml*) ws_core=true ;; esac
  printf '{"profiles":"%s","services":{%s},"mem_total_kb":%s,"mem_available_kb":%s,"disk_free_kb":%s,"core":%s,"verbs":[%s],"checked_at":"%s"}\n' \
    "$ws_profiles" "$ws_body" "$(num_or "$ws_mt" null)" "$(num_or "$ws_ma" null)" "$(num_or "$ws_df" null)" \
    "$ws_core" "$UPDATER_VERBS" "$(now)" > "$SIG/services.json.tmp" \
    && mv "$SIG/services.json.tmp" "$SIG/services.json"
}

# gen_token: 64 hex chars from the kernel CSPRNG on stdout; non-zero (and
# nothing printed) when that cannot be had.
gen_token() {
  gt_hex=$(od -An -tx1 -N32 /dev/urandom 2>/dev/null | tr -d ' \n')
  case "$gt_hex" in '' | *[!0-9a-f]*) return 1 ;; esac
  [ "${#gt_hex}" -eq 64 ] || return 1
  printf '%s' "$gt_hex"
}

# ensure_service_tokens: give every optional service its bearer token on a
# roll, whether or not the service is on. A token is inert by itself (the
# profile decides what runs, and the brain reads the profile, not the token),
# and a roll recreates every app container anyway, so this is the free moment
# to put it in their env. Afterwards a dashboard switch starts or stops one
# container instead of restarting the brain. An existing token is never
# rotated.
#
# Only on a compose whose app services read the live state (the read-only
# /signal mount): a brain built before that reads "token set" as "on", and a
# provisioned token would light up a service that is not running.
ensure_service_tokens() {
  if ! grep -q 'update-signal:/signal:ro' "$STACK/docker-compose.yml" 2>/dev/null; then
    echo "[updater] optional-service tokens not provisioned: this box's compose predates the live service state" \
      | tee -a "$SIG/update.log"
    return 0
  fi
  for est_s in $SERVICE_PROFILES; do
    est_v=$(service_token_var "$est_s")
    [ -z "$(env_val "$est_v")" ] || continue
    if est_tok=$(gen_token) && persist_env "$est_v" "$est_tok"; then
      echo "[updater] $est_v provisioned (the $est_s service stays as it is: the profile decides)" | tee -a "$SIG/update.log"
    else
      echo "[updater] ⚠ could not provision $est_v; switching $est_s on will restart the app containers once" \
        | tee -a "$SIG/update.log"
    fi
  done
}

# ── switching an optional service on or off ──────────────────────────────────
# The dashboard's service switch writes /signal/service-request.json, a file
# of its OWN: an updater older than this never reads it, where the same body
# in request.json would read as "roll to latest". One fixed operation per
# request, inputs whitelisted: the service is `sandboxes` or `media`, the
# switch true or false. Nothing else in the request reaches a command.
#
# On:  free-disk check; back up .env; give the service its token (and, for
#      sandboxes, the host-absolute sandboxes dir) when missing; add the
#      profile; pull THAT service's image (plus the sandbox base image); start
#      THAT container with `up --no-deps`, or, when the token was only just
#      written, recreate the app containers too so they carry it (once per
#      box, a roll normally provisions it first); wait for healthy. Any
#      failure puts .env back and stops the container again.
# Off: stop the running sandbox containers (stop, NEVER remove), stop and
#      remove the service container, drop the profile. Tokens, the sandboxes
#      dir, every sandbox's /files, app data and images all stay: off loses
#      nothing, and on again is quick.
#
# Status: /signal/service-status.json {phase, service, enable, started_at,
# finished_at, ok, error}; the run's output in /signal/service.log.
#
# .env knobs (the operator's, never the request's):
#   MANTLE_SERVICE_MIN_FREE_MB=4096   free disk an "on" needs first
#   MANTLE_SERVICE_HEALTH_TIMEOUT_S=180  how long "on" waits for healthy
SVC_ENV_BAK=""
SVC_ERR=""
SVC_TOKEN_NEW=""

compose_service() {
  case "$1" in sandboxes) echo sandboxd ;; media) echo media ;; esac
}

# write_service_status <phase> <service> <enable> <started> <finished> <ok|""> <error>
write_service_status() {
  wss_err=$(printf '%s' "$7" | tr '\n"' ' .' | cut -c1-300)
  printf '{"phase":"%s","service":"%s","enable":%s,"started_at":"%s","finished_at":"%s","ok":%s,"error":"%s"}\n' \
    "$1" "$2" "$3" "$4" "$5" "${6:-null}" "$wss_err" > "$SIG/service-status.json.tmp" \
    && mv "$SIG/service-status.json.tmp" "$SIG/service-status.json"
}

svc_log() { echo "[updater] $*" | tee -a "$SIG/service.log"; }

# svc_compose <profile> <args...>: compose against the box's stack with the
# profile named explicitly, so stop/rm reach the service whatever .env says.
svc_compose() {
  sc_p=$1; shift
  docker compose --project-directory "$STACK" --profile "$sc_p" "$@" >> "$SIG/service.log" 2>&1
}

# backup_env: copy .env (mode and owner kept) to backups/env/, newest 5 kept.
backup_env() {
  be_dir="$STACK/backups/env"
  ( umask 077; mkdir -p "$be_dir" ) || return 1
  SVC_ENV_BAK="$be_dir/.env-$(date -u +%Y%m%d-%H%M%S)"
  cp -p "$STACK/.env" "$SVC_ENV_BAK" || return 1
  keep_newest "$be_dir/.env-" 5
}

# restore_env: put the backup back IN PLACE (the inode keeps its owner/mode).
restore_env() {
  [ -n "$SVC_ENV_BAK" ] && [ -f "$SVC_ENV_BAK" ] || return 1
  cat "$SVC_ENV_BAK" > "$STACK/.env"
}

# profiles_without <name>: COMPOSE_PROFILES minus <name>, as a comma list.
profiles_without() {
  profiles_csv | tr ',' '\n' | grep -vx "$1" | tr '\n' ',' | sed 's/,$//'
}

# sandboxes_host_dir: <data dir>/sandboxes, host-absolute (sandboxd hands it to
# the host daemon as a bind source; the stack dir is host-absolute already).
sandboxes_host_dir() {
  shd=$(env_val MANTLE_DATA_DIR)
  [ -n "$shd" ] || shd=./data
  case "$shd" in /*) ;; *) shd="$STACK/${shd#./}" ;; esac
  printf '%s/sandboxes' "${shd%/}"
}

# sandbox_base_image: the image sandbox_create starts from (.env pin, else the
# compose default), or nothing when it is not a plain image reference.
sandbox_base_image() {
  sbi=$(env_val SANDBOX_DEFAULT_IMAGE)
  [ -n "$sbi" ] || sbi=$(sed -n 's/.*SANDBOX_DEFAULT_IMAGE: \${SANDBOX_DEFAULT_IMAGE:-\([^}]*\)}.*/\1/p' \
    "$STACK/docker-compose.yml" 2>/dev/null | head -1)
  case "$sbi" in '' | *[!A-Za-z0-9._/:@-]*) return 1 ;; esac
  printf '%s' "$sbi"
}

# wait_healthy <container>: 0 once it runs healthy (or runs with no
# healthcheck); 1 with WH_ERR when it stops, turns unhealthy or times out.
wait_healthy() {
  wh_t=$(num_or "$(env_val MANTLE_SERVICE_HEALTH_TIMEOUT_S)" 180)
  wh_n=$(( (wh_t + 2) / 3 ))
  while [ "$wh_n" -gt 0 ]; do
    wh_s=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      "$1" 2>/dev/null | head -1)
    case "$wh_s" in
      'running healthy' | 'running none') return 0 ;;
      'running unhealthy') WH_ERR="it reports unhealthy"; return 1 ;;
      running* | restarting* | created*) : ;;
      *) WH_ERR="the container is ${wh_s:-missing}"; return 1 ;;
    esac
    sleep 3
    wh_n=$((wh_n - 1))
  done
  WH_ERR="not healthy after ${wh_t}s"
  return 1
}

# service_on_failed <name> <reason>: undo an "on" and say so.
service_on_failed() {
  svc_log "switching $1 on FAILED: $2. Restoring .env and stopping the container."
  restore_env || svc_log "⚠ could not restore .env from $SVC_ENV_BAK"
  svc_compose "$1" stop "$(compose_service "$1")" || true
  svc_compose "$1" rm -f "$(compose_service "$1")" || true
  SVC_ERR="$2; it was switched off again and the settings were restored (see service.log)"
  return 1
}

# service_on <name>: 0 when the service runs healthy, else 1 with SVC_ERR.
service_on() {
  so_svc=$(compose_service "$1")
  so_min_mb=$(num_or "$(env_val MANTLE_SERVICE_MIN_FREE_MB)" 4096)
  so_free=$(free_kb "$STACK")
  if [ -n "$so_free" ] && [ "$so_free" -lt $((so_min_mb * 1024)) ]; then
    SVC_ERR="not enough disk: $((so_free / 1024)) MB free, need $so_min_mb MB. Free space (old images, old backups) and try again; nothing changed"
    return 1
  fi
  backup_env || { SVC_ERR="could not back up .env; nothing changed"; return 1; }
  svc_log ".env backed up to ${SVC_ENV_BAK#"$STACK"/}"

  so_tv=$(service_token_var "$1")
  SVC_TOKEN_NEW=""
  if [ -z "$(env_val "$so_tv")" ]; then
    so_tok=$(gen_token) || { service_on_failed "$1" "could not generate $so_tv"; return 1; }
    persist_env "$so_tv" "$so_tok" || { service_on_failed "$1" "could not write $so_tv"; return 1; }
    SVC_TOKEN_NEW=1
    svc_log "$so_tv provisioned"
  fi
  if [ "$1" = sandboxes ] && [ -z "$(env_val MANTLE_SANDBOXES_HOST_DIR)" ]; then
    so_hd=$(sandboxes_host_dir)
    case "$so_hd" in
      *[!A-Za-z0-9._/-]*) service_on_failed "$1" "the data dir path has characters a bind mount cannot take: $so_hd"; return 1 ;;
    esac
    persist_env MANTLE_SANDBOXES_HOST_DIR "$so_hd" || { service_on_failed "$1" "could not write MANTLE_SANDBOXES_HOST_DIR"; return 1; }
    svc_log "MANTLE_SANDBOXES_HOST_DIR=$so_hd"
  fi
  if ! profile_active "$1"; then
    so_rest=$(profiles_csv)
    persist_env COMPOSE_PROFILES "${so_rest:+$so_rest,}$1" || { service_on_failed "$1" "could not write COMPOSE_PROFILES"; return 1; }
  fi

  write_service_status pulling "$1" true "$SVC_STARTED" "" null ""
  svc_log "downloading $so_svc"
  svc_compose "$1" pull "$so_svc" || { service_on_failed "$1" "the download failed"; return 1; }
  if [ "$1" = sandboxes ]; then
    if so_img=$(sandbox_base_image); then
      svc_log "downloading the sandbox base image $so_img"
      docker pull "$so_img" >> "$SIG/service.log" 2>&1 \
        || svc_log "⚠ the sandbox base image did not download; the first new sandbox will fetch it"
    fi
  fi

  write_service_status starting "$1" true "$SVC_STARTED" "" null ""
  if [ -n "$SVC_TOKEN_NEW" ]; then
    # The app containers do not have the token yet: recreate them with it
    # (the roll's own service list: everything but this updater and caddy).
    so_list=$(docker compose --project-directory "$STACK" config --services 2>/dev/null | grep -vx updater | grep -vx caddy | tr '\n' ' ')
    svc_log "new token: recreating the app containers so they carry it (once)"
    # shellcheck disable=SC2086  # word-splitting the service list is intended
    svc_compose "$1" up -d $so_list || { service_on_failed "$1" "the containers did not start"; return 1; }
  else
    svc_compose "$1" up -d --no-deps "$so_svc" || { service_on_failed "$1" "the container did not start"; return 1; }
  fi
  svc_log "waiting for $(service_container "$1") to report healthy"
  wait_healthy "$(service_container "$1")" || { service_on_failed "$1" "it did not become healthy: $WH_ERR"; return 1; }
  return 0
}

# service_off <name>: 0 when the service is stopped and its profile dropped,
# else 1 with SVC_ERR (and .env as it was).
service_off() {
  so_svc=$(compose_service "$1")
  backup_env || { SVC_ERR="could not back up .env; nothing changed"; return 1; }
  if [ "$1" = sandboxes ]; then
    # Running sandboxes outlive sandboxd (separate containers, restart: no)
    # and nothing would idle-stop them. Stop, never remove: the container
    # keeps its installed packages and /files stays on the host.
    so_ids=$(docker ps -q --filter label=mantle.sandbox=true 2>/dev/null | tr '\n' ' ')
    if [ -n "$(printf '%s' "$so_ids" | tr -d ' ')" ]; then
      svc_log "stopping running sandboxes (kept, not removed): $so_ids"
      # shellcheck disable=SC2086  # one argument per container id
      docker stop -t 20 $so_ids >> "$SIG/service.log" 2>&1 \
        || { SVC_ERR="could not stop the running sandboxes; nothing else changed"; return 1; }
    fi
  fi
  svc_log "stopping $so_svc"
  svc_compose "$1" stop "$so_svc" || { SVC_ERR="could not stop $so_svc; nothing changed in .env"; return 1; }
  svc_compose "$1" rm -f "$so_svc" || { SVC_ERR="could not remove the $so_svc container; nothing changed in .env"; return 1; }
  persist_env COMPOSE_PROFILES "$(profiles_without "$1")" \
    || { SVC_ERR="$so_svc is stopped but COMPOSE_PROFILES could not be written; the next roll would start it again"; return 1; }
  return 0
}

# handle_service_request: consume /signal/service-request.json and run it.
handle_service_request() {
  hs_body=$(cat "$SIG/service-request.json" 2>/dev/null)
  rm -f "$SIG/service-request.json"
  hs_svc=$(printf '%s' "$hs_body" | sed -n 's/.*"service"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  hs_en=$(printf '%s' "$hs_body" | sed -n 's/.*"enable"[[:space:]]*:[[:space:]]*\([a-z]*\).*/\1/p' | head -1)
  SVC_STARTED=$(now)
  # The whitelist: the only request input that reaches a command.
  case "$hs_svc" in
    sandboxes | media) : ;;
    *) write_service_status error "" null "$SVC_STARTED" "$(now)" false "unknown service"; return 0 ;;
  esac
  case "$hs_en" in
    true | false) : ;;
    *) write_service_status error "$hs_svc" null "$SVC_STARTED" "$(now)" false "the switch must be true or false"; return 0 ;;
  esac
  hs_cfg=$(config_error)
  if [ -n "$hs_cfg" ]; then
    write_service_status error "$hs_svc" "$hs_en" "$SVC_STARTED" "$(now)" false "updater not configured: $hs_cfg"
    return 0
  fi
  : > "$SIG/service.log"
  SVC_ENV_BAK=""; SVC_ERR=""
  if [ "$hs_en" = true ]; then
    write_service_status pulling "$hs_svc" true "$SVC_STARTED" "" null ""
    svc_log "switching $hs_svc ON"
    if service_on "$hs_svc"; then
      write_service_status done "$hs_svc" true "$SVC_STARTED" "$(now)" true ""
      svc_log "done: $hs_svc is on"
    else
      write_service_status error "$hs_svc" true "$SVC_STARTED" "$(now)" false "$SVC_ERR"
    fi
  else
    write_service_status stopping "$hs_svc" false "$SVC_STARTED" "" null ""
    svc_log "switching $hs_svc OFF (data is kept)"
    if service_off "$hs_svc"; then
      write_service_status done "$hs_svc" false "$SVC_STARTED" "$(now)" true ""
      svc_log "done: $hs_svc is off; its data is kept"
    else
      write_service_status error "$hs_svc" false "$SVC_STARTED" "$(now)" false "$SVC_ERR"
    fi
  fi
  write_services_info
}

# Library mode for scripts/test-deploy-scripts.sh: with MANTLE_UPDATER_LIB=1
# the file defines its functions and stops here, so the refresh logic runs
# against a fake stack with a stubbed docker instead of the poll loop.
[ "${MANTLE_UPDATER_LIB:-}" != 1 ] || return 0

CFG_ERR=$(config_error)
if [ -n "$CFG_ERR" ]; then
  echo "[updater] not configured: $CFG_ERR." \
       "Set MANTLE_STACK_DIR=<absolute stack dir> in .env — install.sh does this automatically." >&2
  write_status unconfigured "" "" "" false "$CFG_ERR"
else
  # Init to idle on first boot, AND self-heal a stale 'unconfigured' left over
  # from a prior misconfiguration now that .env is fixed — otherwise the settings
  # page would keep showing the old error and hang on the next update.
  case "$(cur_phase)" in
    '' | unconfigured) write_status idle "" "" "" null "" ;;
  esac
  echo "[updater] ready — stack: $STACK"
  topup_scripts
  write_stack_info
fi

# We deliberately do NOT dead-sleep when unconfigured. Staying in the poll loop
# lets us (a) answer a queued request with a terminal 'error' so the settings UI
# stops spinning instead of waiting forever, and (b) recover the instant STACK
# becomes valid.

# ── poll loop ────────────────────────────────────────────────────────────────
while true; do
  if [ -f "$SIG/request.json" ]; then
    TARGET=$(sed -n 's/.*"target"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SIG/request.json" | head -1)
    # `client_target` (not `target`) names the owner-UI (jackdaw) tag. Present
    # WITH target: roll both, client to exactly this tag. Present WITHOUT
    # target: interface-only update, the server stack is not touched.
    CLIENT_TARGET=$(sed -n 's/.*"client_target"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SIG/request.json" | head -1)
    rm -f "$SIG/request.json"
    # No target at all (legacy request shape) still means "server → latest";
    # but a request naming ONLY the client must not drag the server anywhere.
    if [ -z "$TARGET" ] && [ -z "$CLIENT_TARGET" ]; then TARGET=latest; fi
    # Tag whitelist — the only externally-controlled input that reaches a command.
    case "$TARGET" in
      *[!A-Za-z0-9._-]*) write_status error "$TARGET" "$(now)" "$(now)" false "invalid tag"; continue ;;
    esac
    case "$CLIENT_TARGET" in
      *[!A-Za-z0-9._-]*) write_status error "$CLIENT_TARGET" "$(now)" "$(now)" false "invalid client tag"; continue ;;
    esac

    # Re-check config at request time. A request that lands while we're
    # unconfigured gets a terminal 'error' (not an eternal "Working…" in the UI).
    CFG_ERR=$(config_error)
    if [ -n "$CFG_ERR" ]; then
      write_status error "$TARGET" "$(now)" "$(now)" false "updater not configured: $CFG_ERR"
      echo "[updater] rejected request → $TARGET (not configured: $CFG_ERR)" >&2
      continue
    fi

    # ── interface-only update (client_target with no server target) ─────────
    if [ -z "$TARGET" ]; then
      STARTED=$(now)
      : > "$SIG/update.log"
      write_status pulling "$CLIENT_TARGET" "$STARTED" "" null ""
      echo "[updater] interface-only update requested → $CLIENT_TARGET" | tee -a "$SIG/update.log"
      CLIENT_ON=$(grep -E '^MANTLE_CLIENT_ENABLED=' "$STACK/.env" 2>/dev/null | head -1 | cut -d= -f2-)
      if [ "$CLIENT_ON" = "0" ]; then
        write_status error "$CLIENT_TARGET" "$STARTED" "$(now)" false "client stack disabled (MANTLE_CLIENT_ENABLED=0)"
        continue
      fi
      if [ ! -f "$STACK/docker-compose.client.yml" ]; then
        write_status error "$CLIENT_TARGET" "$STARTED" "$(now)" false "no client compose on this box"
        continue
      fi
      # Persist first for the same reason the server path does: a later manual
      # `docker compose up` must re-resolve to THIS tag, not fall back to
      # :latest. Recorded as auto-managed — it arrived through the managed path.
      persist_env MANTLE_CLIENT_IMAGE_TAG "$CLIENT_TARGET"
      printf '%s\n' "$CLIENT_TARGET" > "$SIG/client-tag.auto"
      PREV_CLIENT_IMG=$(container_image mantle_client_web)
      if docker compose -f "$STACK/docker-compose.client.yml" --project-directory "$STACK" pull >> "$SIG/update.log" 2>&1; then
        write_status rolling "$CLIENT_TARGET" "$STARTED" "" null ""
        if docker compose -f "$STACK/docker-compose.client.yml" --project-directory "$STACK" up -d --remove-orphans >> "$SIG/update.log" 2>&1; then
          write_status done "$CLIENT_TARGET" "$STARTED" "$(now)" true ""
          echo "[updater] done → interface $CLIENT_TARGET" | tee -a "$SIG/update.log"
          if [ "$(env_val MANTLE_IMAGE_PRUNE)" != 0 ]; then
            pi_ns=$(env_val MANTLE_IMAGE_NAMESPACE)
            prune_repo "${pi_ns:-titanwest}/mantle-client" "$PREV_CLIENT_IMG" "$(container_image mantle_client_web)" | tee -a "$SIG/update.log"
          fi
        else
          write_status error "$CLIENT_TARGET" "$STARTED" "$(now)" false "client compose up failed — see update.log"
        fi
      else
        write_status error "$CLIENT_TARGET" "$STARTED" "$(now)" false "client compose pull failed — see update.log"
      fi
      write_stack_info
      continue
    fi

    STARTED=$(now)
    : > "$SIG/update.log"
    # Claim the run IMMEDIATELY — before the .env rewrite, not after it. From
    # the moment request.json is consumed until a new status is written, the
    # web app reads the PREVIOUS run's status: it has no pending request to
    # infer 'requested' from, so a prior 'error'/'done' is all it can see and
    # it reports the last run's outcome as this one's. Every statement between
    # here and the write widens that window (the .env rewrite forks sed+mv),
    # so there are none. The client is independently race-proofed against it
    # via started_at, since the window can never be closed to zero.
    write_status pulling "$TARGET" "$STARTED" "" null ""
    echo "[updater] update requested → $TARGET" | tee -a "$SIG/update.log"

    # The client logins floor first: a refusal there needs no backup.
    if client_floor_refusal "$TARGET"; then
      write_status error "$TARGET" "$STARTED" "$(now)" false "roll refused, nothing changed: $CFR_ERR"
      echo "[updater] ROLL REFUSED before any change: $CFR_ERR" | tee -a "$SIG/update.log"
      write_stack_info
      continue
    fi

    # The pre-roll backup comes FIRST, before any file on the box changes (see
    # pre_roll_backup). A refusal leaves .env, compose, Caddyfile, scripts and
    # every container exactly as they were.
    if ! pre_roll_backup; then
      write_status error "$TARGET" "$STARTED" "$(now)" false "roll refused, nothing changed: $PRB_ERR"
      echo "[updater] ROLL REFUSED before any change: $PRB_ERR" | tee -a "$SIG/update.log"
      write_stack_info
      continue
    fi
    # The images running now are the rollback pair the prune below keeps.
    PREV_SERVER_IMG=$(container_image mantle_web)
    PREV_CLIENT_IMG=$(container_image mantle_client_web)

    # Persist the tag so a later manual `docker compose up` doesn't roll back.
    # persist_env: temp-file rewrite that keeps .env's owner and mode (a bare
    # redirect from this root sidecar left it root:root 0644).
    [ "$TARGET" = latest ] || persist_env MANTLE_IMAGE_TAG "$TARGET"

    # Refresh the (pristine) compose from the target image BEFORE `compose
    # pull`/`up`, so a release's compose-level changes — new services, mounts,
    # healthchecks — take effect in the SAME roll as its image. (Phase is
    # already 'pulling' — claimed above the .env rewrite.)
    CADDY_RECREATE=""
    refresh_compose "$TARGET"
    # Front door too (same image, same roll): a release that changes the
    # Caddyfile or a shape lands with its image, no hand copy per box.
    [ "$REFRESH" = pull-failed ] || refresh_caddy "$TARGET"
    # Operator tooling rides the same roll. It does not affect THIS update —
    # the scripts are run by hand — but it is what stops the next one being
    # applied by a compose-adopt three releases behind the compose it installs.
    [ "$REFRESH" = pull-failed ] || refresh_scripts "$TARGET"
    # After the compose refresh (the check reads the compose this roll brings
    # up) and before the pull/up that recreates the app containers with it.
    ensure_service_tokens
    if docker compose --project-directory "$STACK" pull >> "$SIG/update.log" 2>&1; then
      write_status rolling "$TARGET" "$STARTED" "" null ""
      # Recreate every service EXCEPT this updater. A bare `up -d` would recreate
      # `updater` too, SIGKILLing this script mid-rollout: the remaining services
      # never start (stuck "Created", site down) and the status freezes at
      # "rolling". Enumerate services and drop ourselves. Nothing depends_on the
      # updater, so omitting it is clean; `--remove-orphans` still only prunes
      # services absent from the compose file (the updater isn't one).
      # Plain `up -d` (not --wait): the app containers — including the web app
      # showing the progress UI — get recreated mid-command, which is expected.
      ROLLABLE=$(docker compose --project-directory "$STACK" config --services 2>/dev/null | grep -vx updater)
      # Hold caddy back too, for AVAILABILITY. It declares
      # `depends_on: web {service_healthy}` — correct for first boot, brutal
      # during an update: including caddy in this `up` parks it behind web's
      # health-start window, so the PUBLIC SITE (including the progress UI the
      # operator is watching) is dead for ~2 min. Worse, that price is usually
      # paid for nothing — on a release that changes neither the Caddyfile nor
      # the floating caddy:2-alpine digest, caddy needs no recreate at all.
      # Rolled separately below with --no-deps: unchanged ⇒ true no-op and
      # caddy never stops serving; changed ⇒ a ~1s recreate instead of ~2 min.
      SERVICES=$(printf '%s\n' "$ROLLABLE" | grep -vx caddy | tr '\n' ' ')
      HAS_CADDY=$(printf '%s\n' "$ROLLABLE" | grep -cx caddy)
      if [ -z "$(printf '%s' "$SERVICES" | tr -d '[:space:]')" ]; then
        write_status error "$TARGET" "$STARTED" "$(now)" false "could not enumerate services to recreate"
        echo "[updater] ERROR: empty service list; aborting to avoid self-recreate" | tee -a "$SIG/update.log"
        continue
      fi
      # shellcheck disable=SC2086  # word-splitting $SERVICES into args is intended
      if docker compose --project-directory "$STACK" up -d --remove-orphans $SERVICES >> "$SIG/update.log" 2>&1; then
        # Converge caddy WITHOUT its depends_on gate (see the hold-back note
        # above). --no-deps is the whole point: it stops compose re-evaluating
        # `web: service_healthy`, so an unchanged caddy is left serving and a
        # changed one is recreated immediately instead of waiting out web's
        # health-start. Non-fatal — the stack is already rolled, and a caddy
        # that failed to converge is still the OLD, working caddy.
        if [ "$HAS_CADDY" -gt 0 ]; then
          # A refreshed Caddyfile/shape is a bind-mount CONTENT change, which
          # compose does not see: force the recreate so caddy reads the new
          # files. CADDY_RECREATE is set by refresh_caddy when ANY front-door
          # file changed, whatever the Caddyfile's own outcome was. Unchanged
          # files keep the cheap no-op path.
          CADDY_FORCE=""
          [ -z "$CADDY_RECREATE" ] || CADDY_FORCE="--force-recreate"
          # shellcheck disable=SC2086  # an empty CADDY_FORCE must vanish, not quote to ""
          if ! docker compose --project-directory "$STACK" up -d --no-deps $CADDY_FORCE caddy >> "$SIG/update.log" 2>&1; then
            echo "[updater] ⚠ caddy did not converge — the previous caddy is still serving; see update.log" | tee -a "$SIG/update.log"
          fi
        fi
        # The client image versions on its OWN stream since the repo split.
        # resolve_client_tag picks what rides with this roll — the request's
        # explicit client_target, else a user pin in .env (honoured), else the
        # tag PAIRED with $TARGET read from the target image — and persists it
        # to .env before the compose pull below resolves the image name.
        # A failure here is loud but non-fatal to the server roll (already done).
        # A headless box (MANTLE_CLIENT_ENABLED=0, install.sh --no-client)
        # runs no owner UI — rolling it would resurrect a deliberately
        # removed container. Missing from .env means ON.
        CLIENT_ON=$(grep -E '^MANTLE_CLIENT_ENABLED=' "$STACK/.env" 2>/dev/null | head -1 | cut -d= -f2-)
        if [ "$CLIENT_ON" = "0" ]; then
          echo "[updater] client stack disabled (MANTLE_CLIENT_ENABLED=0) — skipping client roll" | tee -a "$SIG/update.log"
        elif [ -f "$STACK/docker-compose.client.yml" ]; then
          resolve_client_tag
          echo "[updater] rolling client stack" | tee -a "$SIG/update.log"
          if ! docker compose -f "$STACK/docker-compose.client.yml" --project-directory "$STACK" pull >> "$SIG/update.log" 2>&1 \
            || ! docker compose -f "$STACK/docker-compose.client.yml" --project-directory "$STACK" up -d --remove-orphans >> "$SIG/update.log" 2>&1; then
            write_status error "$TARGET" "$STARTED" "$(now)" false "server rolled OK but CLIENT stack roll failed — see update.log"
            write_stack_info
            continue
          fi
        fi
        write_status done "$TARGET" "$STARTED" "$(now)" true ""
        echo "[updater] done → $TARGET" | tee -a "$SIG/update.log"
        # Old images of this product only, after the status is terminal: a
        # prune problem must never turn an OK roll into a failed one.
        prune_images "$PREV_SERVER_IMG" "$PREV_CLIENT_IMG"
        # Self-refresh LAST, on the success path only: a failed roll should
        # change as little as possible, and the status the UI polls is already
        # terminal. Sets UPDATER_REFRESH for the write_stack_info below.
        UPDATER_REFRESH=$(refresh_updater)
        case "$UPDATER_REFRESH" in
          refreshed|adopted) echo "[updater] updater script $UPDATER_REFRESH from the $TARGET canonical" | tee -a "$SIG/update.log" ;;
          current) : ;;
          unavailable) echo "[updater] updater self-refresh skipped: $IMG ships no embedded updater.sh (pre-v0.206 image)" | tee -a "$SIG/update.log" ;;
          modified) echo "[updater] ⚠ UPDATER SCRIPT NOT REFRESHED: $UPDATER_REL has LOCAL EDITS." \
               "This script takes all box-specific input from the environment and has no supported local variation;" \
               "restore it from the release (or delete $UPDATER_REL.release to re-adopt) or this box keeps running OLD update logic." | tee -a "$SIG/update.log" ;;
          syntax-error|not-a-script) echo "[updater] ⚠ updater self-refresh REFUSED: incoming script failed its sanity check ($UPDATER_REFRESH)." \
               "Keeping the current copy — installing it would crash-loop the sidecar." | tee -a "$SIG/update.log" ;;
          *) echo "[updater] ⚠ updater self-refresh: $UPDATER_REFRESH" | tee -a "$SIG/update.log" ;;
        esac
      else
        write_status error "$TARGET" "$STARTED" "$(now)" false "compose up failed — see update.log"
      fi
    else
      write_status error "$TARGET" "$STARTED" "$(now)" false "compose pull failed — see update.log"
    fi
    write_stack_info
    # Enter the refreshed script. Everything the settings page reads —
    # status.json, stack.json, update.log — is already final on disk, so being
    # replaced here costs nothing. MUST be the stack-dir path: /updater.sh is a
    # FILE bind-mount pinned to the pre-swap inode (see refresh_updater note 2).
    case "$UPDATER_REFRESH" in
      refreshed | adopted)
        echo "[updater] re-entering the refreshed script" | tee -a "$SIG/update.log"
        exec sh "$STACK/$UPDATER_REL"
        ;;
    esac
  fi
  # A service switch (one at a time; a roll above always goes first).
  if [ -f "$SIG/service-request.json" ]; then
    handle_service_request
  fi
  # Keep the compose fingerprint fresh (~5 min) so manual edits and manual
  # `docker compose pull` rolls surface on /settings/updates without an update
  # request. TICKS is cheap int arithmetic in busybox sh.
  TICKS=$((${TICKS:-0} + 1))
  if [ "$TICKS" -ge 60 ]; then
    TICKS=0
    [ -z "$(config_error)" ] && write_stack_info
  fi
  sleep 5
done
