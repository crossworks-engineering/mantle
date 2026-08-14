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

SIG=/signal
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
UPDATER_REFRESH=none  # last updater-script refresh outcome (stack.json)

# This script's own path INSIDE the container, reached through the stack-dir
# mount rather than the /updater.sh entrypoint mount. The distinction is load-
# bearing — see refresh_updater().
UPDATER_REL=infra/updater/updater.sh

sha_of() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

# Compose + updater-script fingerprints for the web app's drift check
# (best-effort). The updater sha is what makes a stale SCRIPT visible: a box
# that cannot self-refresh (modified copy, extraction failure) otherwise
# reports a perfectly healthy update while silently running old logic.
write_stack_info() {
  printf '{"compose_sha":"%s","baseline_sha":"%s","client_compose_sha":"%s","client_baseline_sha":"%s","core_compose_sha":"%s","core_baseline_sha":"%s","updater_sha":"%s","updater_baseline_sha":"%s","refresh":"%s","client_refresh":"%s","core_refresh":"%s","updater_refresh":"%s","checked_at":"%s"}\n' \
    "$(sha_of "$STACK/docker-compose.yml")" \
    "$(sha_of "$STACK/docker-compose.yml.release")" \
    "$(sha_of "$STACK/docker-compose.client.yml")" \
    "$(sha_of "$STACK/docker-compose.client.yml.release")" \
    "$(sha_of "$STACK/docker-compose.core.yml")" \
    "$(sha_of "$STACK/docker-compose.core.yml.release")" \
    "$(sha_of "$STACK/$UPDATER_REL")" \
    "$(sha_of "$STACK/$UPDATER_REL.release")" \
    "$REFRESH" "$CLIENT_REFRESH" "$CORE_REFRESH" "$UPDATER_REFRESH" "$(now)" > "$SIG/stack.json.tmp" \
    && mv "$SIG/stack.json.tmp" "$SIG/stack.json"
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
         "Run scripts/compose-adopt.sh once from the stack dir. Continuing on the EXISTING compose." | tee -a "$SIG/update.log" ;;
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
    rm -f "$SIG/request.json"
    [ -n "$TARGET" ] || TARGET=latest
    # Tag whitelist — the only externally-controlled input that reaches a command.
    case "$TARGET" in
      *[!A-Za-z0-9._-]*) write_status error "$TARGET" "$(now)" "$(now)" false "invalid tag"; continue ;;
    esac

    # Re-check config at request time. A request that lands while we're
    # unconfigured gets a terminal 'error' (not an eternal "Working…" in the UI).
    CFG_ERR=$(config_error)
    if [ -n "$CFG_ERR" ]; then
      write_status error "$TARGET" "$(now)" "$(now)" false "updater not configured: $CFG_ERR"
      echo "[updater] rejected request → $TARGET (not configured: $CFG_ERR)" >&2
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
    # Temp-file rewrite, not `sed -i` — the in-place flag's syntax differs
    # between busybox (this image) and BSD sed and silently misbehaves.
    if [ "$TARGET" != "latest" ]; then
      if grep -q '^MANTLE_IMAGE_TAG=' "$STACK/.env" 2>/dev/null; then
        sed "s/^MANTLE_IMAGE_TAG=.*/MANTLE_IMAGE_TAG=$TARGET/" "$STACK/.env" > "$STACK/.env.updater-tmp" \
          && mv "$STACK/.env.updater-tmp" "$STACK/.env"
      else
        printf '\nMANTLE_IMAGE_TAG=%s\n' "$TARGET" >> "$STACK/.env"
      fi
    fi

    # Refresh the (pristine) compose from the target image BEFORE `compose
    # pull`/`up`, so a release's compose-level changes — new services, mounts,
    # healthchecks — take effect in the SAME roll as its image. (Phase is
    # already 'pulling' — claimed above the .env rewrite.)
    refresh_compose "$TARGET"
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
          if ! docker compose --project-directory "$STACK" up -d --no-deps caddy >> "$SIG/update.log" 2>&1; then
            echo "[updater] ⚠ caddy did not converge — the previous caddy is still serving; see update.log" | tee -a "$SIG/update.log"
          fi
        fi
        # v0.200+ lockstep: roll the CLIENT stack with the same tag (its compose
        # reads the same $STACK/.env, so the persisted MANTLE_IMAGE_TAG applies).
        # A failure here is loud but non-fatal to the server roll (already done).
        if [ -f "$STACK/docker-compose.client.yml" ]; then
          echo "[updater] rolling client stack → $TARGET" | tee -a "$SIG/update.log"
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
