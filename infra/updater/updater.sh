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
# Status surface (read by /settings/updates):
#   /signal/status.json  — {"phase","target","started_at","finished_at","ok","error"}
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

REFRESH=none   # last compose-refresh outcome, reported via stack.json

sha_of() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

# Compose fingerprints for the web app's drift check (best-effort).
write_stack_info() {
  printf '{"compose_sha":"%s","baseline_sha":"%s","refresh":"%s","checked_at":"%s"}\n' \
    "$(sha_of "$STACK/docker-compose.yml")" \
    "$(sha_of "$STACK/docker-compose.yml.release")" \
    "$REFRESH" "$(now)" > "$SIG/stack.json.tmp" \
    && mv "$SIG/stack.json.tmp" "$SIG/stack.json"
}

# refresh_compose <tag> — extract the canonical compose from the target image
# and swap it in when the box copy is pristine. Sets REFRESH; never blocks the
# update (every outcome is reported, the image roll continues regardless).
refresh_compose() {
  ns=$(sed -n 's/^MANTLE_IMAGE_NAMESPACE=//p' "$STACK/.env" 2>/dev/null | head -1)
  img="${ns:-titanwest}/mantle:$1"
  incoming="$STACK/.compose-incoming.tmp"
  rm -f "$incoming"
  echo "[updater] compose refresh: reading canonical from $img" | tee -a "$SIG/update.log"
  if ! docker pull "$img" >> "$SIG/update.log" 2>&1; then
    REFRESH=pull-failed
    echo "[updater] compose refresh skipped: could not pull $img" | tee -a "$SIG/update.log"
    return
  fi
  cid=$(docker create "$img" 2>> "$SIG/update.log") || { REFRESH=extract-failed; return; }
  docker cp "$cid:/app/release/docker-compose.yml" "$incoming" >> "$SIG/update.log" 2>&1
  docker rm "$cid" > /dev/null 2>&1
  if [ ! -s "$incoming" ]; then
    # Target image predates the embedded canonical (< v0.142) — nothing to
    # refresh from; on a deep rollback swap the compose manually
    # (docker-compose.yml.prev holds the previous canonical).
    REFRESH=unavailable
    rm -f "$incoming"
    echo "[updater] compose refresh skipped: $img ships no embedded canonical" | tee -a "$SIG/update.log"
    return
  fi
  if [ ! -f "$STACK/docker-compose.yml.release" ]; then
    REFRESH=no-baseline
    rm -f "$incoming"
    echo "[updater] ⚠ COMPOSE NOT REFRESHED: no baseline (pre-adoption box)." \
         "Run scripts/compose-adopt.sh once from the stack dir to enable automatic" \
         "compose refresh. Continuing on the EXISTING compose." | tee -a "$SIG/update.log"
    return
  fi
  if cmp -s "$STACK/docker-compose.yml" "$STACK/docker-compose.yml.release"; then
    # Pristine — swap in the new canonical (mv over cp: atomic, and never
    # rewrites an inode a running process may hold open). Keep the outgoing
    # file as .prev for one-step rollback.
    if cp "$STACK/docker-compose.yml" "$STACK/docker-compose.yml.prev" \
      && cp "$incoming" "$STACK/.compose-release.tmp" \
      && mv "$STACK/.compose-release.tmp" "$STACK/docker-compose.yml.release" \
      && mv "$incoming" "$STACK/docker-compose.yml"; then
      REFRESH=refreshed
      echo "[updater] compose refreshed to the $1 canonical" | tee -a "$SIG/update.log"
    else
      REFRESH=write-failed
      rm -f "$incoming" "$STACK/.compose-release.tmp"
      echo "[updater] ⚠ compose refresh FAILED writing files — continuing on the existing compose" | tee -a "$SIG/update.log"
    fi
  else
    REFRESH=modified
    rm -f "$incoming"
    echo "[updater] ⚠ COMPOSE NOT REFRESHED: docker-compose.yml has LOCAL EDITS." \
         "Move box-local customization to docker-compose.override.yml + .env, then run" \
         "scripts/compose-adopt.sh to re-baseline. Running the new image on the OLD compose" \
         "— release-level compose changes (sidecars/healthchecks/mounts) are MISSING here." | tee -a "$SIG/update.log"
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

    write_status pulling "$TARGET" "$STARTED" "" null ""
    # Refresh the (pristine) compose from the target image BEFORE `compose
    # pull`/`up`, so a release's compose-level changes — new services, mounts,
    # healthchecks — take effect in the SAME roll as its image.
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
      SERVICES=$(docker compose --project-directory "$STACK" config --services 2>/dev/null | grep -vx updater | tr '\n' ' ')
      if [ -z "$(printf '%s' "$SERVICES" | tr -d '[:space:]')" ]; then
        write_status error "$TARGET" "$STARTED" "$(now)" false "could not enumerate services to recreate"
        echo "[updater] ERROR: empty service list; aborting to avoid self-recreate" | tee -a "$SIG/update.log"
        continue
      fi
      # shellcheck disable=SC2086  # word-splitting $SERVICES into args is intended
      if docker compose --project-directory "$STACK" up -d --remove-orphans $SERVICES >> "$SIG/update.log" 2>&1; then
        write_status done "$TARGET" "$STARTED" "$(now)" true ""
        echo "[updater] done → $TARGET" | tee -a "$SIG/update.log"
      else
        write_status error "$TARGET" "$STARTED" "$(now)" false "compose up failed — see update.log"
      fi
    else
      write_status error "$TARGET" "$STARTED" "$(now)" false "compose pull failed — see update.log"
    fi
    write_stack_info
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
