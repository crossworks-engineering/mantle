#!/bin/sh
#
# Mantle updater sidecar — the execution half of in-app updates.
#
# The web app DETECTS new releases and REQUESTS an update by writing
# /signal/request.json (a volume shared only with the app containers — no
# ports, no network surface). This script polls for that request and performs
# exactly one fixed operation:
#
#   docker compose pull && docker compose up -d
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

# ── preflight ────────────────────────────────────────────────────────────────
if [ -z "$STACK" ] || [ ! -f "$STACK/docker-compose.yml" ]; then
  echo "[updater] MANTLE_STACK_DIR is not set (or no docker-compose.yml at '$STACK')." \
       "Set MANTLE_STACK_DIR=<absolute stack dir> in .env — install.sh does this automatically." >&2
  write_status unconfigured "" "" "" false "MANTLE_STACK_DIR not set or compose file missing"
  # Sleep forever instead of crash-looping; the settings page surfaces the hint.
  while true; do sleep 3600; done
fi
if ! docker compose version >/dev/null 2>&1; then
  write_status unconfigured "" "" "" false "docker compose plugin unavailable in updater image"
  while true; do sleep 3600; done
fi

[ -f "$SIG/status.json" ] || write_status idle "" "" "" null ""
echo "[updater] ready — stack: $STACK"

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
    if docker compose --project-directory "$STACK" pull >> "$SIG/update.log" 2>&1; then
      write_status rolling "$TARGET" "$STARTED" "" null ""
      # Plain `up -d` (not --wait): this very container's siblings — including
      # the web app showing the progress UI — get recreated mid-command.
      if docker compose --project-directory "$STACK" up -d --remove-orphans >> "$SIG/update.log" 2>&1; then
        write_status done "$TARGET" "$STARTED" "$(now)" true ""
        echo "[updater] done → $TARGET" | tee -a "$SIG/update.log"
      else
        write_status error "$TARGET" "$STARTED" "$(now)" false "compose up failed — see update.log"
      fi
    else
      write_status error "$TARGET" "$STARTED" "$(now)" false "compose pull failed — see update.log"
    fi
  fi
  sleep 5
done
