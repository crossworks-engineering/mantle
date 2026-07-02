#!/usr/bin/env bash
#
# Mantle one-line installer — pulls the published Docker image and starts the
# full stack with generated secrets. No manual .env editing needed for a
# localhost install; a domain install is one env var.
#
#   curl -fsSL https://raw.githubusercontent.com/crossworks-engineering/mantle/main/install.sh | bash
#
# Options (env vars, set before the pipe or export first):
#   MANTLE_HOME=~/mantle          install directory          (default: ./mantle)
#   MANTLE_DOMAIN=m.example.com   serve this hostname with automatic HTTPS
#                                 (DNS A record + open ports 80/443 first);
#                                 omit for http://localhost
#   MANTLE_CHANNEL=main           git ref to fetch the deploy bundle from
#                                 (default: main; a release tag like v0.108.0
#                                 pins compose+infra to that release)
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
CHANNEL="${MANTLE_CHANNEL:-main}"
HOME_DIR="${MANTLE_HOME:-./mantle}"
DOMAIN="${MANTLE_DOMAIN:-}"
SKIP_START="${MANTLE_SKIP_START:-}"

say()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. prerequisites ─────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker is not installed — https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing — https://docs.docker.com/compose/install/"
docker info >/dev/null 2>&1 || die "the docker daemon isn't running (or you lack permission — add your user to the docker group)"

# ── 2. scaffold + fetch the deploy bundle ────────────────────────────────────
say "Installing Mantle into ${HOME_DIR} (bundle ref: ${CHANNEL})"
mkdir -p "$HOME_DIR/infra/caddy" "$HOME_DIR/infra/postgres/init" "$HOME_DIR/infra/updater" "$HOME_DIR/scripts" "$HOME_DIR/data"
cd "$HOME_DIR"

fetch() { # fetch <repo-path> <local-path>
  curl -fsSL "${REPO_RAW}/${CHANNEL}/$1" -o "$2" || die "download failed: $1"
}

fetch docker-compose.yml                 docker-compose.yml
fetch .env.prod.example                  .env.prod.example
fetch infra/caddy/Caddyfile              infra/caddy/Caddyfile
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
chmod +x scripts/db-dump.sh scripts/db-restore.sh scripts/install.sh scripts/sanity.sh
ok "deploy bundle fetched"

# ── 3. configure + start + verify — ONE code path ────────────────────────────
# Everything from here (secret generation that never rotates an existing
# master key, DNS pre-check before enabling TLS, MANTLE_PUBLIC_URL, pull,
# up --wait through the migrate gate, and the per-service sanity check) lives
# in scripts/install.sh — the same script used to reconfigure a box later
# (e.g. `scripts/install.sh --domain m.example.com` to add HTTPS).
ARGS=(--stack-dir "$(pwd -P)" --data-dir ./data -y)
if [ -n "$DOMAIN" ]; then ARGS+=(--domain "$DOMAIN"); else ARGS+=(--no-domain); fi
# A release-tag channel pins the image to the same version as the bundle, so
# compose + image can never drift apart.
case "$CHANNEL" in v[0-9]*) ARGS+=(--image-tag "$CHANNEL") ;; esac
[ -n "$SKIP_START" ] && ARGS+=(--skip-up)

bash scripts/install.sh "${ARGS[@]}"

if [ -n "$SKIP_START" ]; then
  ok "MANTLE_SKIP_START set — scaffold + .env done; start later with: docker compose up -d --wait"
  exit 0
fi

# ── 7. done ──────────────────────────────────────────────────────────────────
URL="${DOMAIN:+https://$DOMAIN}"; URL="${URL:-http://localhost}"
ok "Mantle is up."
cat <<EOF

  1. Open ${URL} and create your account (first visit → sign up).
  2. The onboarding wizard takes it from there: assistant, API keys,
     email, Telegram — all configured in the interface.

  Your data lives in $(pwd)/data — back it up and it IS your brain.
  Update later:   cd $(pwd) && docker compose pull && docker compose up -d --wait
  Full guide:     https://github.com/crossworks-engineering/mantle/blob/main/docs/self-hosting.md
EOF
