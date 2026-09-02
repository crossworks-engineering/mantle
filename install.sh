#!/usr/bin/env bash
#
# Mantle one-line installer — pulls the published Docker image and starts the
# full stack with generated secrets. No manual .env editing needed for a
# localhost install; a domain install is one env var.
#
#   curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh | bash
#
# Options (env vars). NOTE: `VAR=x curl … | bash` does NOT reach bash on the
# right of the pipe — export first, or use the substitution form:
#   MANTLE_DOMAIN=m.example.com bash -c "$(curl -fsSL <this url>)"
#   MANTLE_HOME=~/mantle          install directory          (default: ./mantle)
#   MANTLE_DOMAIN=m.example.com   serve this hostname with automatic HTTPS
#                                 (DNS A record + open ports 80/443 first);
#                                 omit for plain HTTP on :80 across this
#                                 machine's network — http://<server-ip>. For
#                                 loopback only, run scripts/install.sh
#                                 --localhost from the bundle afterwards.
#   MANTLE_CHANNEL=main           git ref to fetch the deploy bundle from
#                                 (default: main; a release tag like v0.108.0
#                                 pins compose+infra to that release)
#   MANTLE_YES=1                  never prompt — take the defaults (the old
#                                 behaviour). Without it, a terminal gets
#                                 asked: how the brain is reached, and which
#                                 components to install (shape, sandboxes,
#                                 local embedder, owner UI).
#
# What it does — and nothing else:
#   1. checks docker + the compose plugin exist
#   2. downloads the deploy bundle (docker-compose.yml, .env.prod.example,
#      infra/caddy/Caddyfile, infra/postgres/init/*.sql, db + install scripts)
#   3. delegates to scripts/install.sh — the single configurator: generates
#      missing secrets (never rotates an existing MANTLE_MASTER_KEY), checks
#      the domain's DNS before enabling TLS, writes MANTLE_PUBLIC_URL, then
#      docker compose pull && up -d --wait and a per-service sanity check
#   4. tells you where to sign up
#
# Updating later (see docs/self-hosting.md):
#   cd <MANTLE_HOME> && docker compose pull && docker compose up -d --wait

set -euo pipefail

# MANTLE_REPO_RAW: override for forks/tests (a fork's raw URL, or a local
# http server in CI). MANTLE_SKIP_START=1 scaffolds + writes .env but skips
# the pull/up — used to test the installer without launching a stack.
REPO_RAW="${MANTLE_REPO_RAW:-https://raw.githubusercontent.com/crossworks-engineering/mantle}"
# Default to the LATEST RELEASE, not main: a `curl | bash` user gets the compose
# that was tested with the images it names, downloaded as the signed deploy
# bundle release.yml publishes (verified against SHA256SUMS). Set
# MANTLE_CHANNEL=main (or any branch) to fall back to raw file-by-file fetch.
CHANNEL="${MANTLE_CHANNEL:-}"
REPO_RELEASES="${MANTLE_REPO_RELEASES:-https://github.com/crossworks-engineering/mantle/releases}"
REPO_API="${MANTLE_REPO_API:-https://api.github.com/repos/crossworks-engineering/mantle}"
HOME_DIR="${MANTLE_HOME:-./mantle}"
DOMAIN="${MANTLE_DOMAIN:-}"
SKIP_START="${MANTLE_SKIP_START:-}"
# MANTLE_LOCAL_EMBEDDER=1 bundles the local embedder (Ollama + EmbeddingGemma,
# ~3.3GB image + model) — off by default; online embedding is set up in onboarding.
LOCAL_EMBEDDER="${MANTLE_LOCAL_EMBEDDER:-}"

say()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. prerequisites ─────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not installed — https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing — https://docs.docker.com/compose/install/"
docker info >/dev/null 2>&1 || die "the docker daemon isn't running (or you lack permission — add your user to the docker group)"

# ── 2. scaffold + fetch the deploy bundle ────────────────────────────────────
if [ -z "$CHANNEL" ]; then
  CHANNEL="$(curl -fsSL "${REPO_API}/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$CHANNEL" ] || { warn "could not resolve the latest release tag — falling back to main"; CHANNEL=main; }
fi
say "Installing Mantle into ${HOME_DIR} (bundle ref: ${CHANNEL})"
mkdir -p "$HOME_DIR/infra/caddy" "$HOME_DIR/infra/postgres/init" "$HOME_DIR/infra/updater" "$HOME_DIR/scripts" "$HOME_DIR/data"
cd "$HOME_DIR"

fetch() { # fetch <repo-path> <local-path>
  curl -fsSL "${REPO_RAW}/${CHANNEL}/$1" -o "$2" || die "download failed: $1"
}

USE_BUNDLE=
case "$CHANNEL" in
  v[0-9]*)
    say "Downloading the signed deploy bundle for ${CHANNEL}"
    tmp="$(mktemp -d)"
    curl -fsSL "${REPO_RELEASES}/download/${CHANNEL}/mantle-deploy-${CHANNEL}.tar.gz" -o "$tmp/bundle.tar.gz" || die "download failed: mantle-deploy-${CHANNEL}.tar.gz"
    curl -fsSL "${REPO_RELEASES}/download/${CHANNEL}/SHA256SUMS" -o "$tmp/SHA256SUMS" || die "download failed: SHA256SUMS"
    want="$(awk '{print $1}' "$tmp/SHA256SUMS" | head -1)"
    if command -v sha256sum >/dev/null 2>&1; then have="$(sha256sum "$tmp/bundle.tar.gz" | awk '{print $1}')"; else have="$(shasum -a 256 "$tmp/bundle.tar.gz" | awk '{print $1}')"; fi
    [ "$want" = "$have" ] || die "bundle checksum mismatch (expected $want, got $have) — refusing to install"
    tar -xzf "$tmp/bundle.tar.gz" --strip-components=1 -C .
    rm -rf "$tmp"
    chmod +x scripts/*.sh
    ok "bundle verified and unpacked"
    USE_BUNDLE=1
    ;;
esac

if [ -z "$USE_BUNDLE" ]; then
fetch docker-compose.yml                 docker-compose.yml
fetch docker-compose.client.yml          docker-compose.client.yml
fetch docker-compose.core.yml            docker-compose.core.yml
# Baselines for the release-owned compose contract: the updater sidecar
# auto-refreshes these files on updates ONLY while each stays byte-identical
# to its baseline (proof the box never hand-edited it — box-local changes go
# in docker-compose.override.yml + .env instead).
cp docker-compose.yml docker-compose.yml.release
cp docker-compose.client.yml docker-compose.client.yml.release
cp docker-compose.core.yml docker-compose.core.yml.release
fetch .env.prod.example                  .env.prod.example
fetch infra/caddy/Caddyfile              infra/caddy/Caddyfile
# The same-origin front door (one domain path-routed to BOTH apps). This is
# what scripts/install.sh installs by default — without it a fresh box serves
# the server app only and the visitor can never reach signup.
fetch infra/caddy/Caddyfile.same-origin  infra/caddy/Caddyfile.same-origin
fetch infra/postgres/init/01-extensions.sql  infra/postgres/init/01-extensions.sql
fetch infra/postgres/init/02-auth-schema.sql infra/postgres/init/02-auth-schema.sql
# The updater sidecar's entrypoint script. Compose bind-mounts it at
# ./infra/updater/updater.sh — if it's missing, Docker silently creates an empty
# DIRECTORY there and mantle_updater crash-loops. MUST stay in sync with every
# host path docker-compose.yml bind-mounts (cf. release.yml's `cp -R infra`).
fetch infra/updater/updater.sh           infra/updater/updater.sh
fetch scripts/db-dump.sh                 scripts/db-dump.sh
fetch scripts/db-restore.sh              scripts/db-restore.sh
# The real configurator + health check — this bootstrap only fetches the
# bundle, then delegates so install/re-install/reconfigure share ONE code path.
fetch scripts/install.sh                 scripts/install.sh
fetch scripts/sanity.sh                  scripts/sanity.sh
fetch scripts/compose-adopt.sh           scripts/compose-adopt.sh
# The uninstaller ships WITH the install. Leaving it out doesn't stop anyone
# removing Mantle — it just means they improvise it, and the improvised version
# is the one that takes the data directory with it.
fetch scripts/uninstall.sh               scripts/uninstall.sh
chmod +x scripts/db-dump.sh scripts/db-restore.sh scripts/install.sh scripts/sanity.sh scripts/compose-adopt.sh scripts/uninstall.sh
fi
ok "deploy bundle fetched"

# ── 3. configure + start + verify — ONE code path ────────────────────────────
# Everything from here (secret generation that never rotates an existing
# master key, DNS pre-check before enabling TLS, MANTLE_PUBLIC_URL, pull,
# up --wait through the migrate gate, and the per-service sanity check) lives
# in scripts/install.sh — the same script used to reconfigure a box later
# (e.g. `scripts/install.sh --domain m.example.com` to add HTTPS).
# Interactive when a terminal exists: scripts/install.sh reads its prompts
# from /dev/tty precisely so `curl … | bash` can still ask questions (access
# mode, what to install). Forcing -y here used to defeat that machinery and
# silently install the defaults. MANTLE_YES=1 restores the old zero-question
# behaviour for scripted runs; no controlling terminal means -y regardless.
ARGS=(--stack-dir "$(pwd -P)" --data-dir ./data)
if [ -n "${MANTLE_YES:-}" ] || [ ! -r /dev/tty ]; then ARGS+=(-y); fi
if [ -n "$DOMAIN" ]; then
  ARGS+=(--domain "$DOMAIN")
elif [ -n "${MANTLE_YES:-}" ] || [ ! -r /dev/tty ]; then
  ARGS+=(--no-domain)   # non-interactive default, unchanged
fi
# A release-tag channel pins the image to the same version as the bundle, so
# compose + image can never drift apart.
case "$CHANNEL" in v[0-9]*) ARGS+=(--image-tag "$CHANNEL") ;; esac
case "$LOCAL_EMBEDDER" in 1|true|yes) ARGS+=(--local-embedder) ;; esac
[ -n "$SKIP_START" ] && ARGS+=(--skip-up)

bash scripts/install.sh "${ARGS[@]}"

if [ -n "$SKIP_START" ]; then
  ok "MANTLE_SKIP_START set — scaffold + .env done; start later with: docker compose up -d --wait"
  exit 0
fi

# ── 7. done ──────────────────────────────────────────────────────────────────
# scripts/install.sh has already printed the address to open — it's the only
# thing that knows which shape was installed. Repeating a guess here is how a
# LAN install came to be advertised as http://localhost.
cat <<EOF

  The onboarding wizard takes it from there: assistant, API keys,
  email, Telegram — all configured in the interface.

  Your data lives in $(pwd)/data — back it up and it IS your brain.
  Update later:   cd $(pwd) && docker compose pull && docker compose up -d --wait
  Full guide:     https://github.com/crossworks-engineering/mantle/blob/main/docs/self-hosting.md
EOF
