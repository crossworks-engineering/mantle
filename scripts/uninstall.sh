#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Mantle uninstaller — take the stack down, and optionally erase the brain.
#
# Two very different operations, deliberately separated:
#
#   • DEFAULT — removes containers, networks and named volumes. Your data
#     directory and .env are untouched, so `scripts/install.sh` brings the
#     same brain straight back. Nothing of value is lost: postgres, the object
#     store, files and backups are BIND-MOUNTED into MANTLE_DATA_DIR, and the
#     only named volumes are a tailscale socket and Caddy's cert cache.
#
#   • --purge — additionally deletes the data directory and .env. That is the
#     brain itself plus MANTLE_MASTER_KEY, which decrypts every stored API key
#     and mailbox password. There is no undo and no copy elsewhere.
#
# Never touches the `mantle-dev` project (the local development containers) —
# that's a different stack that happens to share a name prefix.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
STACK_DIR_DEFAULT="$(pwd -P)"

# ── pretty output (matches install.sh) ───────────────────────────────────────
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  B=$'\033[1m'; DIM=$'\033[2m'; RS=$'\033[0m'
  RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLU=$'\033[34m'; CYN=$'\033[36m'
else B=; DIM=; RS=; RED=; GRN=; YLW=; BLU=; CYN=; fi
hd()   { printf '\n%s━━ %s %s\n' "$B$CYN" "$*" "$RS"; }
ok()   { printf '  %s✓%s %s\n' "$GRN" "$RS" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$RS" "$*"; }
warn() { printf '  %s!%s %s\n' "$YLW" "$RS" "$*"; }
inf()  { printf '  %s•%s %s\n' "$BLU" "$RS" "$*"; }
die()  { printf '\n%s✗ %s%s\n' "$RED$B" "$*" "$RS" >&2; exit 1; }
row()  { printf '  %s%-14s%s %s\n' "$DIM" "$1" "$RS" "$2"; }

# Prompts read the terminal, not stdin — a piped run (`curl … | bash`) has no
# stdin of its own and would "answer" every confirmation instantly with the
# default. On a destructive script that is not a cosmetic problem.
TTY_IN=0
if [[ -r /dev/tty ]] && { exec 3</dev/tty; } 2>/dev/null; then TTY_IN=1; fi
getline() { local __gl=""; if [[ $TTY_IN -eq 1 ]]; then read -r __gl <&3 || true; else read -r __gl || true; fi; printf -v "$1" '%s' "$__gl"; }

# ── args ─────────────────────────────────────────────────────────────────────
STACK_DIR="${MANTLE_STACK_DIR:-$STACK_DIR_DEFAULT}"
DATA_DIR=""; PURGE=0; IMAGES=0; DRY=0; ASSUME_YES=0
usage() {
  cat <<EOF
${B}Mantle uninstaller${RS}

  scripts/uninstall.sh [options]

${B}Options${RS}
  --purge          Also delete the data directory and .env — the brain itself.
                   IRREVERSIBLE: MANTLE_MASTER_KEY goes with it, and without
                   that key every stored API key and password is unrecoverable.
  --images         Also remove the pulled Mantle images (frees ~4GB; they
                   re-download on the next install)
  --stack-dir <p>  Where docker-compose.yml lives (default: this directory)
  --data-dir <p>   Override the data directory (default: read from .env)
  --dry-run        Print what would be removed, change nothing
  -y, --yes        Don't prompt (for --purge this is the ONLY confirmation)
  -h, --help       This help

${B}Examples${RS}
  scripts/uninstall.sh                 # stop + remove the stack, keep the brain
  scripts/uninstall.sh --dry-run       # show what that would touch
  scripts/uninstall.sh --purge         # erase everything, with confirmation
EOF
}
while [[ $# -gt 0 ]]; do case "$1" in
  --purge) PURGE=1; shift ;;
  --images) IMAGES=1; shift ;;
  --stack-dir) STACK_DIR="${2:-}"; shift 2 ;;
  --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
  --dry-run) DRY=1; shift ;;
  -y|--yes) ASSUME_YES=1; shift ;;
  -h|--help) usage; exit 0 ;;
  *) die "unknown argument: $1  (try --help)" ;;
esac; done

command -v docker >/dev/null 2>&1 || die "Docker isn't installed — nothing to uninstall."
docker info >/dev/null 2>&1 || die "The Docker daemon isn't running; start it so the containers can be removed."

ENV_FILE="$STACK_DIR/.env"
envval() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
# The data directory is whatever THIS install was configured with — never a
# guess. A wrong path here is the difference between erasing the brain and
# erasing something else entirely.
if [[ -z "$DATA_DIR" ]]; then DATA_DIR="$(envval MANTLE_DATA_DIR)"; fi
DATA_DIR="${DATA_DIR:-$STACK_DIR/data}"
case "$DATA_DIR" in /*) ;; *) DATA_DIR="$STACK_DIR/${DATA_DIR#./}" ;; esac

# Project names come from the `name:` key in each compose file, so they hold
# regardless of what the directory is called.
proj_of() { awk '/^name:[[:space:]]/{print $2; exit}' "$1" 2>/dev/null || true; }
SERVER_PROJECT="$(proj_of "$STACK_DIR/docker-compose.yml")"; SERVER_PROJECT="${SERVER_PROJECT:-mantle}"
CLIENT_PROJECT="$(proj_of "$STACK_DIR/docker-compose.client.yml")"; CLIENT_PROJECT="${CLIENT_PROJECT:-mantle-client}"
[[ "$SERVER_PROJECT" == "mantle-dev" ]] && die "Refusing to run: that's the development stack, not an install."

# ── what is actually here ────────────────────────────────────────────────────
hd "What will be removed"
count_of() { docker ps -aq --filter "label=com.docker.compose.project=$1" 2>/dev/null | wc -l | tr -d ' '; }
SERVER_N="$(count_of "$SERVER_PROJECT")"; CLIENT_N="$(count_of "$CLIENT_PROJECT")"
VOLS="$(docker volume ls -q --filter "label=com.docker.compose.project=$SERVER_PROJECT" 2>/dev/null | wc -l | tr -d ' ')"
VOLS_C="$(docker volume ls -q --filter "label=com.docker.compose.project=$CLIENT_PROJECT" 2>/dev/null | wc -l | tr -d ' ')"

row "Stack dir" "$STACK_DIR"
row "Containers" "$SERVER_N in ${B}$SERVER_PROJECT${RS}, $CLIENT_N in ${B}$CLIENT_PROJECT${RS}"
row "Volumes" "$((VOLS + VOLS_C)) named ${DIM}(cert cache + a socket — no user data)${RS}"
if [[ $((SERVER_N + CLIENT_N)) -eq 0 ]]; then
  warn "No Mantle containers found — nothing is running under these project names."
fi

if [[ -d "$DATA_DIR" ]]; then
  # A bare "0" next to "WILL BE DELETED" reads as "there's nothing here" — the
  # opposite of what a confirmation should convey if du just can't measure it.
  # `|| true`: on a real deploy the postgres/minio subdirs are root-owned, so
  # du prints a partial total but EXITS NONZERO — under pipefail + set -e that
  # killed the whole uninstall right after the summary (found on the first
  # non-root --purge run). The partial size is still worth showing.
  SIZE="$(du -sh "$DATA_DIR" 2>/dev/null | awk '{print $1}' || true)"
  case "$SIZE" in ''|0) SIZE='size unknown' ;; esac
  if [[ $PURGE -eq 1 ]]; then
    row "Data" "${RED}$DATA_DIR ($SIZE) — WILL BE DELETED${RS}"
    row ".env" "${RED}$([[ -f "$ENV_FILE" ]] && printf 'WILL BE DELETED — master key included' || printf 'not present')${RS}"
  else
    row "Data" "$DATA_DIR ($SIZE) ${GRN}kept${RS}"
    row ".env" "$([[ -f "$ENV_FILE" ]] && printf 'kept' || printf 'not present')"
  fi
fi
[[ $IMAGES -eq 1 ]] && row "Images" "Mantle images will be removed too"

if [[ $PURGE -eq 1 ]]; then
  printf '\n'
  bad "This erases the brain: the database, the object store, every uploaded file,"
  bad "and MANTLE_MASTER_KEY — without which stored API keys and mailbox passwords"
  bad "cannot be decrypted, even from a backup taken later."
  if [[ -d "$DATA_DIR/backups" ]]; then
    inf "${DIM}Database dumps in $DATA_DIR/backups go too. Copy them elsewhere first if you want them.${RS}"
  fi
fi

if [[ $DRY -eq 1 ]]; then hd "Dry run"; inf "Nothing was changed."; exit 0; fi

# ── confirm ──────────────────────────────────────────────────────────────────
if [[ $ASSUME_YES -eq 0 ]]; then
  if [[ $TTY_IN -eq 0 ]]; then
    die "No terminal to confirm on. Re-run with -y if you are certain$([[ $PURGE -eq 1 ]] && printf ' (with --purge this deletes everything)')."
  fi
  printf '\n'
  if [[ $PURGE -eq 1 ]]; then
    # A y/n keypress is too cheap for something with no undo. Typing the word
    # takes a deliberate act, which is the point.
    printf '  %sType %sPURGE%s to confirm, anything else to cancel:%s ' "$B" "$RED" "$B$RS$B" "$RS"
    getline answer
    [[ "$answer" == "PURGE" ]] || die "Cancelled. Nothing was changed."
  else
    printf '  %sRemove the stack? Your data stays.%s [y/N] ' "$B" "$RS"
    getline answer
    [[ "$answer" =~ ^[Yy] ]] || die "Cancelled. Nothing was changed."
  fi
fi

# ── take it down ─────────────────────────────────────────────────────────────
hd "Removing the stack"
COMPOSE_BASE=(docker compose --project-directory "$STACK_DIR")
[[ -f "$ENV_FILE" ]] && COMPOSE_BASE+=(--env-file "$ENV_FILE")

# Ad-hoc SANDBOX containers first. They are sandboxd's children, not compose
# services (created via the docker socket, selected by the mantle.sandbox
# label), so no `down` ever sees them — and while one is attached, the fixed-
# name sandbox networks below refuse to delete. Their /files work dirs live
# under MANTLE_SANDBOXES_HOST_DIR and are deliberately NOT touched here — the
# data section owns data decisions.
SBX="$(docker ps -aq --filter "label=mantle.sandbox=true" 2>/dev/null || true)"
if [[ -n "$SBX" ]]; then
  # shellcheck disable=SC2086
  docker rm -f $SBX >/dev/null 2>&1 && ok "Sandbox containers removed (their /files dirs are kept)"
fi

# The client is its OWN compose project; the server's `down` doesn't touch it,
# and the shared network won't delete while its containers are still attached.
if [[ -f "$STACK_DIR/docker-compose.client.yml" ]]; then
  "${COMPOSE_BASE[@]}" -f "$STACK_DIR/docker-compose.client.yml" down -v --remove-orphans >/dev/null 2>&1 \
    && ok "Owner UI stack removed" || warn "Owner UI stack: nothing to remove (or already gone)"
fi
# Explicit profiles so opted-in services are included regardless of whether
# .env (and its COMPOSE_PROFILES line) still exists by the time this runs:
# local-embedder covers Ollama, sandboxes covers sandboxd. Harmless otherwise.
"${COMPOSE_BASE[@]}" --profile local-embedder --profile sandboxes down -v --remove-orphans >/dev/null 2>&1 \
  && ok "Server stack removed" || warn "Server stack: nothing to remove (or already gone)"

# Anything left behind by an older layout or a hand-run container.
# One query per project: repeating a label filter with the SAME key ANDs them,
# so asking for project=mantle AND project=mantle-client matches nothing at all
# and this cleanup silently did nothing.
STRAGGLERS="$( { docker ps -aq --filter "label=com.docker.compose.project=$SERVER_PROJECT" 2>/dev/null
                 docker ps -aq --filter "label=com.docker.compose.project=$CLIENT_PROJECT" 2>/dev/null; } | sort -u || true)"
if [[ -n "$STRAGGLERS" ]]; then
  docker rm -f $STRAGGLERS >/dev/null 2>&1 && ok "Removed leftover containers"
fi
# The sandbox networks carry FIXED names (not ${project}_default), so they
# need naming here explicitly; with the sandbox containers already gone they
# delete cleanly (compose's own down usually gets them first — this is the
# backstop for a half-torn state).
for net in "${SERVER_PROJECT}_default" "${CLIENT_PROJECT}_default" mantle_sandbox mantle_sandbox_restricted; do
  docker network rm "$net" >/dev/null 2>&1 && ok "Network $net removed" || true
done

if [[ $IMAGES -eq 1 ]]; then
  IMGS="$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^titanwest/mantle(-client|-server|-sandbox)?:' || true)"
  if [[ -n "$IMGS" ]]; then
    # shellcheck disable=SC2086
    docker rmi $IMGS >/dev/null 2>&1 && ok "Mantle images removed" || warn "Some images are still in use and were kept"
  else ok "No Mantle images to remove"; fi
fi

# ── purge ────────────────────────────────────────────────────────────────────
if [[ $PURGE -eq 1 ]]; then
  hd "Erasing data"
  if [[ -f "$ENV_FILE" ]]; then rm -f "$ENV_FILE" && ok "Deleted $ENV_FILE"; fi
  if [[ -d "$DATA_DIR" ]]; then
    # Containers create these directories as root, so an unprivileged rm fails
    # partway and leaves a confusing half-deleted tree. Try directly, then via
    # sudo, then — when neither is available — through a throwaway container,
    # which runs as root by definition and needs no password.
    if rm -rf "$DATA_DIR" 2>/dev/null && [[ ! -d "$DATA_DIR" ]]; then
      ok "Deleted $DATA_DIR"
    elif command -v sudo >/dev/null 2>&1 && sudo -n rm -rf "$DATA_DIR" 2>/dev/null; then
      ok "Deleted $DATA_DIR ${DIM}(via sudo)${RS}"
    else
      parent="$(dirname "$DATA_DIR")"; leaf="$(basename "$DATA_DIR")"
      if docker run --rm -v "$parent:/target" alpine:latest sh -c "rm -rf /target/$leaf" >/dev/null 2>&1; then
        ok "Deleted $DATA_DIR ${DIM}(root-owned; removed via a throwaway container)${RS}"
      else
        bad "Could not delete $DATA_DIR — it is root-owned. Remove it with: sudo rm -rf '$DATA_DIR'"
      fi
    fi
  fi
fi

# ── done ─────────────────────────────────────────────────────────────────────
hd "Done"
if [[ $PURGE -eq 1 ]]; then
  inf "Mantle is gone. A fresh ${B}scripts/install.sh${RS} starts from nothing."
else
  inf "Stack removed; your brain is still in ${B}$DATA_DIR${RS}."
  inf "Bring it back with ${B}scripts/install.sh${RS} — same data, same keys."
fi
