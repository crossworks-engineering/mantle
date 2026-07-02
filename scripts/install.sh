#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Mantle installer — smooth first-run setup for a self-hosted box.
#
#   • Generates the secrets you'd otherwise hand-edit (MANTLE_MASTER_KEY,
#     SESSION_SECRET, S3 creds) — but only the ones that are MISSING, so a
#     re-run never rotates your master key and orphans sealed secrets.
#   • Asks whether you have a domain pointing at this server and, if so, checks
#     that it actually resolves here BEFORE enabling TLS — so Caddy only attempts
#     a Let's Encrypt cert when it can succeed (no wasted issuance / rate-limit).
#   • Brings the stack up and runs a post-install sanity check.
#
# Interactive by default; fully scriptable via flags (see --help) for automated
# deploys. Safe to re-run (idempotent).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
STACK_DIR_DEFAULT="$(pwd -P)"

# ── pretty output ────────────────────────────────────────────────────────────
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
banner() {
  printf '%s\n' "$B$CYN"
  printf '   ┌──────────────────────────────────────────┐\n'
  printf '   │   %smantle%s%s   ·   installer                 │\n' "$RS$B" "$RS$B$CYN" "$CYN"
  printf '   └──────────────────────────────────────────┘%s\n' "$RS"
}

# ── args ─────────────────────────────────────────────────────────────────────
DOMAIN="${MANTLE_DOMAIN:-}"; NO_DOMAIN=0; SITE_ADDRESS="${MANTLE_SITE_ADDRESS:-}"
DATA_DIR="${MANTLE_DATA_DIR:-./data}"; STACK_DIR="${MANTLE_STACK_DIR:-$STACK_DIR_DEFAULT}"
IMAGE_TAG="${MANTLE_IMAGE_TAG:-latest}"; ASSUME_YES=0; SKIP_UP=0; SANITY_ONLY=0
usage() {
  cat <<EOF
${B}Mantle installer${RS}

  scripts/install.sh [options]

${B}Options${RS}
  --domain <host>        Use this domain (enables HTTPS via Caddy/Let's Encrypt)
  --no-domain            HTTP only on :80 (no domain / no TLS)
  --site-address <addr>  Set MANTLE_SITE_ADDRESS verbatim (advanced; overrides above)
  --data-dir <path>      MANTLE_DATA_DIR (default: ./data) — all data binds here
  --stack-dir <path>     MANTLE_STACK_DIR (default: this dir) — used by the updater
  --image-tag <tag>      MANTLE_IMAGE_TAG (default: latest)
  -y, --yes              Non-interactive: accept defaults, never prompt
  --skip-up              Write .env only; don't bring the stack up
  --sanity, --check      Only run the post-install sanity check, then exit
  -h, --help             This help

${B}Examples${RS}
  scripts/install.sh                              # interactive
  scripts/install.sh --domain brain.acme.com -y   # scripted, HTTPS
  scripts/install.sh --no-domain -y               # scripted, HTTP only
  scripts/install.sh --check                       # health check an existing install
EOF
}
while [[ $# -gt 0 ]]; do case "$1" in
  --domain) DOMAIN="${2:-}"; shift 2 ;;
  --no-domain) NO_DOMAIN=1; shift ;;
  --site-address) SITE_ADDRESS="${2:-}"; shift 2 ;;
  --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
  --stack-dir) STACK_DIR="${2:-}"; shift 2 ;;
  --image-tag) IMAGE_TAG="${2:-}"; shift 2 ;;
  -y|--yes|--non-interactive) ASSUME_YES=1; shift ;;
  --skip-up) SKIP_UP=1; shift ;;
  --sanity|--check) SANITY_ONLY=1; shift ;;
  -h|--help) usage; exit 0 ;;
  *) die "unknown argument: $1  (try --help)" ;;
esac; done

ENV_FILE="$STACK_DIR/.env"

# ── sanity-only shortcut ─────────────────────────────────────────────────────
if [[ $SANITY_ONLY -eq 1 ]]; then exec bash "$(dirname "$0")/sanity.sh"; fi

banner

# ── 1. preflight ─────────────────────────────────────────────────────────────
hd "Preflight"
command -v docker >/dev/null 2>&1 || die "Docker isn't installed. Install Docker Engine + Compose, then re-run."
docker info >/dev/null 2>&1 || die "Docker daemon isn't running. Start it, then re-run."
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin isn't available (need 'docker compose')."
command -v openssl >/dev/null 2>&1 || die "openssl isn't installed — it's needed to generate the master key + secrets."
[[ -f "$STACK_DIR/docker-compose.yml" ]] || die "No docker-compose.yml in $STACK_DIR — run this from the stack directory (or pass --stack-dir)."
ok "Docker + Compose ready"
inf "Stack dir: ${B}$STACK_DIR${RS}"
inf "Data dir:  ${B}$DATA_DIR${RS}  ${DIM}(all volumes bind here)${RS}"

# ── 2. domain / TLS ──────────────────────────────────────────────────────────
hd "Domain & HTTPS"
detect_ip() {
  local ip
  ip=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null) \
    || ip=$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null) \
    || ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  printf '%s' "$ip"
}
resolve_ip() { # $1 = host → first A record (getent is always present on Linux)
  getent ahostsv4 "$1" 2>/dev/null | awk 'NR==1{print $1}'
}
PUBLIC_IP="$(detect_ip)"
[[ -n "$PUBLIC_IP" ]] && inf "This server's public IP looks like ${B}$PUBLIC_IP${RS}"

# Resolve the site address unless one was passed verbatim.
if [[ -z "$SITE_ADDRESS" ]]; then
  if [[ $NO_DOMAIN -eq 0 && -z "$DOMAIN" && $ASSUME_YES -eq 0 ]]; then
    printf '  %sDo you have a domain pointing to this server?%s (needed for HTTPS) [y/N] ' "$B" "$RS"
    read -r reply || reply=""
    if [[ "$reply" =~ ^[Yy] ]]; then
      printf '  %sDomain%s (e.g. brain.example.com): ' "$B" "$RS"; read -r DOMAIN || DOMAIN=""
    else NO_DOMAIN=1; fi
  fi
  if [[ -n "$DOMAIN" ]]; then
    RESOLVED="$(resolve_ip "$DOMAIN")"
    if [[ -z "$RESOLVED" ]]; then
      warn "$DOMAIN doesn't resolve yet. Caddy can't get a certificate until it points here."
    elif [[ -n "$PUBLIC_IP" && "$RESOLVED" != "$PUBLIC_IP" ]]; then
      warn "$DOMAIN resolves to ${B}$RESOLVED${RS}, not this server (${B}$PUBLIC_IP${RS})."
      warn "Caddy will keep failing to get a cert until DNS points here."
    else
      ok "$DOMAIN resolves to this server — Caddy will get a certificate on boot."
    fi
    if [[ -n "$RESOLVED" && -n "$PUBLIC_IP" && "$RESOLVED" != "$PUBLIC_IP" && $ASSUME_YES -eq 0 ]]; then
      printf '  Proceed anyway (HTTP until DNS is fixed)? [y/N] '; read -r go || go=""
      [[ "$go" =~ ^[Yy] ]] || die "Fix the DNS A record ($DOMAIN → $PUBLIC_IP), then re-run."
      SITE_ADDRESS=":80"; warn "Using HTTP (:80) for now — re-run with --domain once DNS is live."
    else
      SITE_ADDRESS="$DOMAIN"
    fi
  else
    SITE_ADDRESS=":80"
    inf "No domain — serving HTTP on :80. Reach it at ${B}http://${PUBLIC_IP:-<server-ip>}${RS} (or via SSH tunnel / Tailscale). Add a domain later by re-running."
  fi
fi
[[ "$SITE_ADDRESS" == ":80" ]] && ok "Site address: HTTP :80" || ok "Site address: ${B}$SITE_ADDRESS${RS} (auto-HTTPS)"

# ── 3. secrets + .env ────────────────────────────────────────────────────────
hd "Configuration (.env)"
getval() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
upsert() { # KEY VALUE — replace-in-place or append; preserves other lines
  local k="$1" v="$2" tmp
  touch "$ENV_FILE"
  if grep -qE "^${k}=" "$ENV_FILE" 2>/dev/null; then
    tmp="$(mktemp)"; grep -vE "^${k}=" "$ENV_FILE" > "$tmp"; printf '%s=%s\n' "$k" "$v" >> "$tmp"; mv "$tmp" "$ENV_FILE"
  else printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"; fi
}
gen_key()    { openssl rand -base64 32 | tr '+/' '-_' | tr -d '='; }  # 43-char base64url
gen_hex()    { openssl rand -hex "${1:-32}"; }
ensure() {  # KEY GENERATOR-CMD — keep existing (never regenerate), else generate
  local k="$1" g="$2" cur; cur="$(getval "$k")"
  if [[ -n "$cur" ]]; then upsert "$k" "$cur"; inf "$k kept (already set)"; else upsert "$k" "$($g)"; ok "$k generated"; fi
}
ensure MANTLE_MASTER_KEY gen_key          # NEVER rotated on re-run (would orphan secrets)
ensure SESSION_SECRET    "gen_hex 48"
ensure S3_ACCESS_KEY     "gen_hex 12"
ensure S3_SECRET_KEY     "gen_hex 24"
upsert MANTLE_SITE_ADDRESS "$SITE_ADDRESS"
# Public origin for share/email links + the onboarding Domain check. Only
# meaningful when a real hostname is set; on :80 (no domain) links would embed
# an address that may change, so it stays unset until a domain is added.
if [[ "$SITE_ADDRESS" != :* ]]; then
  upsert MANTLE_PUBLIC_URL "https://$SITE_ADDRESS"
fi
upsert MANTLE_DATA_DIR     "$DATA_DIR"
upsert MANTLE_STACK_DIR    "$STACK_DIR"
upsert MANTLE_IMAGE_TAG    "$IMAGE_TAG"
chmod 600 "$ENV_FILE" 2>/dev/null || true
ok "Wrote ${B}$ENV_FILE${RS} ${DIM}(chmod 600)${RS}"

if [[ $SKIP_UP -eq 1 ]]; then hd "Done (--skip-up)"; inf "Config written; stack not started. Bring it up with: ${B}docker compose up -d --wait${RS}"; exit 0; fi

# ── 4. bring the stack up ────────────────────────────────────────────────────
hd "Starting the stack"
COMPOSE=(docker compose --env-file "$ENV_FILE" --project-directory "$STACK_DIR")
inf "Pulling images (tag: ${B}$IMAGE_TAG${RS})…"
"${COMPOSE[@]}" pull -q 2>&1 | sed 's/^/    /' \
  || warn "Image pull failed. If the image is private, run 'docker login <registry>' and re-run. Continuing so the sanity check can report."
inf "Bringing services up (waits for migrate + health)…"
"${COMPOSE[@]}" up -d --wait || warn "up --wait returned non-zero — the sanity check below will show what's wrong."

# ── 5. sanity check ──────────────────────────────────────────────────────────
bash "$(dirname "$0")/sanity.sh" || true

hd "Installation complete"
if [[ "$SITE_ADDRESS" == ":80" ]]; then
  inf "Open ${B}http://${PUBLIC_IP:-<server-ip>}${RS} and finish onboarding."
else
  inf "Open ${B}https://$SITE_ADDRESS${RS} and finish onboarding."
fi
