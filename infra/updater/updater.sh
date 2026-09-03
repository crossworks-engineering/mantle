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
SCRIPT_NAMES='db-dump.sh db-restore.sh install.sh sanity.sh compose-adopt.sh uninstall.sh'

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
      if docker compose -f "$STACK/docker-compose.client.yml" --project-directory "$STACK" pull >> "$SIG/update.log" 2>&1; then
        write_status rolling "$CLIENT_TARGET" "$STARTED" "" null ""
        if docker compose -f "$STACK/docker-compose.client.yml" --project-directory "$STACK" up -d --remove-orphans >> "$SIG/update.log" 2>&1; then
          write_status done "$CLIENT_TARGET" "$STARTED" "$(now)" true ""
          echo "[updater] done → interface $CLIENT_TARGET" | tee -a "$SIG/update.log"
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
