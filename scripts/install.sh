#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Mantle installer — smooth first-run setup for a self-hosted box.
#
#   • Asks how the brain should be reached — a domain with HTTPS, this machine
#     only, or this machine's network — and settles every consequence of that
#     choice (listen address, origins, what to open at the end) in one place.
#   • For a domain, proves the DNS points HERE before enabling TLS, comparing
#     every A/AAAA record against this box's public and local addresses. Caddy
#     only attempts a Let's Encrypt cert when it can succeed, so a typo costs
#     nothing instead of burning that name's issuance limit.
#   • Generates the secrets you'd otherwise hand-edit (MANTLE_MASTER_KEY,
#     SESSION_SECRET, S3 creds) — but only the ones that are MISSING, so a
#     re-run never rotates your master key and orphans sealed secrets.
#   • Checks disk, memory and the ports it needs BEFORE the ~2 GB pull, shows
#     what it's about to do, then brings the stack up.
#   • Ends on the sanity check's verdict — and exits non-zero when it fails,
#     rather than printing "complete" over a broken install.
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
step() { printf '  %s%s%s\n' "$DIM" "$*" "$RS"; }

# ── interaction ──────────────────────────────────────────────────────────────
# A piped install (`curl -fsSL … | bash`) has no stdin of its own: a bare
# `read` returns instantly with an empty string, so EVERY prompt would answer
# itself with the default and the operator would never see a question they were
# meant to answer — silently choosing "no domain" on a box that has one. Read
# from the controlling terminal instead, and when there genuinely isn't one,
# say so and take the defaults in the open.
TTY_IN=0
if [[ -r /dev/tty ]] && { exec 3</dev/tty; } 2>/dev/null; then TTY_IN=1; fi
INTERACTIVE=0   # decided once the args are parsed
# Local names here are deliberately obscure: these helpers assign to a variable
# named by the CALLER, so an ordinary name like `__a` would shadow the caller's
# own and silently swallow every answer.
getline() { # $1 = destination var; returns non-zero at end of input
  local __gl_ans="" __gl_rc=0
  if [[ $TTY_IN -eq 1 ]]; then read -r __gl_ans <&3 || __gl_rc=1
  else                         read -r __gl_ans    || __gl_rc=1; fi
  printf -v "$1" '%s' "$__gl_ans"
  return $__gl_rc
}
ask() { # $1 = var, $2 = prompt, $3 = default
  local __ask_d="${3:-}" __ask_a=""
  if [[ $INTERACTIVE -eq 0 ]]; then printf -v "$1" '%s' "$__ask_d"; return 0; fi
  printf '  %s%s%s%s ' "$B" "$2" "$RS" "${__ask_d:+ ${DIM}[$__ask_d]${RS}}"
  if ! getline __ask_a; then
    # Input ended (a closed pipe, a detached terminal). Never keep re-asking a
    # question nothing can answer — say so once and fall back to defaults.
    printf '\n'; warn "Input ended — continuing with defaults."
    INTERACTIVE=0
  fi
  printf -v "$1" '%s' "${__ask_a:-$__ask_d}"
}
port_busy() { # $1 = port → 0 when something is already listening on it
  if command -v ss >/dev/null 2>&1; then ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q ":$1"
  elif command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else return 1; fi   # can't tell → assume free; compose will report the truth
}
port_ours() { # $1 = port → 0 when THIS install already publishes it
  docker ps --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" \
    --format '{{.Ports}}' 2>/dev/null | grep -q ":$1->"
}
# The question that actually matters is "is this port unavailable TO US", not
# "is anything listening". Re-running the installer on a healthy box — the
# supported way to add a domain later — would otherwise find its OWN Caddy on
# :80, call it taken, and move a working front door to :8080 for no reason.
# Our own container is about to be recreated, so its port is ours to keep.
port_taken() { port_busy "$1" && ! port_ours "$1"; }
confirm() { # $1 = prompt, $2 = default y|n → 0 when yes
  local __cf_d="${2:-y}" __cf_a=""
  if [[ $INTERACTIVE -eq 0 ]]; then [[ "$__cf_d" == y ]]; return; fi
  printf '  %s%s%s %s ' "$B" "$1" "$RS" "$([[ $__cf_d == y ]] && printf '[Y/n]' || printf '[y/N]')"
  if ! getline __cf_a; then printf '\n'; warn "Input ended — continuing with defaults."; INTERACTIVE=0; fi
  __cf_a="${__cf_a:-$__cf_d}"
  [[ "$__cf_a" =~ ^[Yy] ]]
}

# ── args ─────────────────────────────────────────────────────────────────────
DOMAIN="${MANTLE_DOMAIN:-}"; SITE_ADDRESS="${MANTLE_SITE_ADDRESS:-}"
ACCESS_MODE=""   # domain | localhost | lan — resolved interactively when unset
DATA_DIR="${MANTLE_DATA_DIR:-./data}"; STACK_DIR="${MANTLE_STACK_DIR:-$STACK_DIR_DEFAULT}"
IMAGE_TAG="${MANTLE_IMAGE_TAG:-latest}"; ASSUME_YES=0; SKIP_UP=0; SANITY_ONLY=0
# Local embedder (bundled Ollama): 1=enable, 0=disable, empty=keep .env as-is.
LOCAL_EMBEDDER="${MANTLE_LOCAL_EMBEDDER:-}"
# CLI sandboxes (sandboxd): 1=enable, 0=disable, empty=default (ON for a FRESH
# box, keep .env as-is on a re-run — existing boxes never flip implicitly).
SANDBOXES="${MANTLE_SANDBOXES:-}"
# Brain-core shape: 1=core (small memory core — channel workers + doc helpers
# off), 0=full, empty=keep .env as-is. See docker-compose.core.yml.
CORE="${MANTLE_CORE:-}"
# Doc helpers (tika parse fallback + PDF-export browser): 1=enable on a core
# box, 0=disable, empty=keep .env as-is. Only meaningful on the core shape;
# the full shape always runs them.
HELPERS="${MANTLE_HELPERS:-}"
# Owner web UI (the separate client stack): 1=run it, 0=headless (API + MCP +
# share pages only — no signup, no owner screens), empty=keep .env as-is
# (missing from .env means ON, the pre-flag behaviour).
CLIENT="${MANTLE_CLIENT:-}"
# Owner UI image tag — its OWN version stream since the repo split (built by
# the frontend repo, default `latest`). Empty=keep .env as-is.
CLIENT_TAG="${MANTLE_CLIENT_IMAGE_TAG:-}"
usage() {
  cat <<EOF
${B}Mantle installer${RS}

  scripts/install.sh [options]

${B}Options${RS}
  --domain <host>        Use this domain (enables HTTPS via Caddy/Let's Encrypt)
  --localhost            This machine only — HTTP on 127.0.0.1:80, not on the network
  --lan                  HTTP on :80, reachable on this machine's network (no TLS)
  --no-domain            Alias for --lan (kept for existing scripts)
  --behind-proxy         You already run nginx/apache on 80/443. Caddy serves plain
                         HTTP on 127.0.0.1:8080 (or the next free port) and your
                         proxy terminates TLS. Combine with --domain for links.
  --site-address <addr>  Set MANTLE_SITE_ADDRESS verbatim (advanced; overrides above).
                         A hostname here means auto-HTTPS just as --domain does, so
                         ports 80 and 443 must be free for the certificate to issue.
  --data-dir <path>      MANTLE_DATA_DIR (default: ./data) — all data binds here
  --stack-dir <path>     MANTLE_STACK_DIR (default: this dir) — used by the updater
  --image-tag <tag>      MANTLE_IMAGE_TAG (default: latest)
  --local-embedder       Enable the bundled local embedder (Ollama + EmbeddingGemma,
                         ~3.3GB image + model). Persists via COMPOSE_PROFILES in .env
                         so every later pull/up — the updater included — keeps it.
                         Needs a LARGE server (degrades a 16GB/8-core box under
                         multi-file ingest) — see docs/self-hosting.md.
  --no-local-embedder    Disable it again (stops the services; images stay until
                         you 'docker image prune' or 'docker rmi ollama/ollama')
  --sandboxes            Enable CLI sandboxes (sandboxd + isolated networks for
                         the coder agent — docs/sandboxes.md). ON by default for
                         a FRESH install; this flag also enables it on an
                         existing box. Persists via COMPOSE_PROFILES in .env,
                         generates SANDBOXD_TOKEN, sets the sandboxes dir under
                         the data dir, and pre-pulls the sandbox base image.
  --no-sandboxes         Install without CLI sandboxes (or disable them again;
                         sandbox /files dirs are never touched)
  --core                 Brain-core shape: a small headless memory core that
                         fits a 2 vCPU / 4 GB box with ONLINE embeddings. Keeps
                         the HTTP API, MCP, share pages, file/docs ingest and
                         backups; sheds the channel workers (email/telegram/
                         microsoft/calendar/push/runs) and the doc helpers
                         (add those back with --helpers). Persists via
                         COMPOSE_FILE in .env so every later pull/up — the
                         updater included — keeps the shape. Sandboxes default
                         OFF for a fresh core box.
  --no-core              Back to the full shape (the shed services start on
                         the next 'docker compose up -d')
  --helpers              Doc helpers on a core box: tika (parse fallback for
                         .odt/.pptx/.doc/.rtf — common formats parse in-process
                         without it) + the PDF-export browser (~2 GB image).
                         Persists via COMPOSE_PROFILES in .env. No effect on
                         the full shape, which always runs both.
  --no-helpers           Shed the doc helpers again on a core box
  --client               Run the owner web UI (the default; a separate small
                         container on its own version stream)
  --no-client            Headless box: API + MCP + share pages only. No owner
                         UI means no signup and no owner screens — pair a
                         headless brain from another brain or over MCP.
                         Persists as MANTLE_CLIENT_ENABLED in .env; the
                         updater and the sanity check honour it.
  --client-image-tag <t> Pin the owner UI image tag (MANTLE_CLIENT_IMAGE_TAG,
                         default: latest — it does NOT follow --image-tag
                         since the repo split)
  -y, --yes              Non-interactive: accept defaults, never prompt
  --skip-up              Write .env only; don't bring the stack up
  --sanity, --check      Only run the post-install sanity check, then exit
  -h, --help             This help

${B}Examples${RS}
  scripts/install.sh                              # interactive
  scripts/install.sh --domain brain.acme.com -y   # scripted, HTTPS
  scripts/install.sh --localhost -y               # scripted, laptop / loopback only
  scripts/install.sh --lan -y                     # scripted, HTTP on the network
  scripts/install.sh --check                       # health check an existing install
EOF
}
while [[ $# -gt 0 ]]; do case "$1" in
  # --domain names the host; it only IMPLIES the mode. An explicit
  # --behind-proxy must survive being written either side of it.
  --domain) DOMAIN="${2:-}"; if [[ -z "$ACCESS_MODE" ]]; then ACCESS_MODE="domain"; fi; shift 2 ;;
  --localhost) ACCESS_MODE="localhost"; shift ;;
  --lan|--no-domain) ACCESS_MODE="lan"; shift ;;
  --behind-proxy) ACCESS_MODE="proxy"; shift ;;
  --site-address) SITE_ADDRESS="${2:-}"; shift 2 ;;
  --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
  --stack-dir) STACK_DIR="${2:-}"; shift 2 ;;
  --image-tag) IMAGE_TAG="${2:-}"; shift 2 ;;
  --local-embedder) LOCAL_EMBEDDER=1; shift ;;
  --no-local-embedder) LOCAL_EMBEDDER=0; shift ;;
  --sandboxes) SANDBOXES=1; shift ;;
  --no-sandboxes) SANDBOXES=0; shift ;;
  --core) CORE=1; shift ;;
  --no-core) CORE=0; shift ;;
  --helpers) HELPERS=1; shift ;;
  --no-helpers) HELPERS=0; shift ;;
  --client) CLIENT=1; shift ;;
  --no-client) CLIENT=0; shift ;;
  --client-image-tag) CLIENT_TAG="${2:-}"; shift 2 ;;
  -y|--yes|--non-interactive) ASSUME_YES=1; shift ;;
  --skip-up) SKIP_UP=1; shift ;;
  --sanity|--check) SANITY_ONLY=1; shift ;;
  -h|--help) usage; exit 0 ;;
  *) die "unknown argument: $1  (try --help)" ;;
esac; done

ENV_FILE="$STACK_DIR/.env"
# Compose derives the project name from the stack directory unless told
# otherwise, lowercasing it and dropping characters it won't accept. Needed to
# tell OUR containers' ports apart from a stranger's — so it has to match what
# compose will actually use, not just the directory name.
# Precedence is compose's own: COMPOSE_PROJECT_NAME, then the `name:` key in
# the compose file, and only then the directory. Reading the file matters — our
# docker-compose.yml sets `name: mantle`, so an install in ~/brain is still the
# `mantle` project. Deriving from the directory alone was wrong everywhere the
# stack dir isn't literally called "mantle", which would make port ownership
# detection silently fail and relocate a working front door on every re-run.
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-}"
if [[ -z "$COMPOSE_PROJECT" ]]; then
  COMPOSE_PROJECT="$(awk '/^name:[[:space:]]/{print $2; exit}' "$STACK_DIR/docker-compose.yml" 2>/dev/null || true)"
fi
COMPOSE_PROJECT="${COMPOSE_PROJECT:-$(basename "$STACK_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')}"
# Prompt only when there is someone to answer AND they didn't ask us not to.
# (`if`, not `[[ … ]] && …` — under `set -e` a false one-liner ends the script.)
if [[ $ASSUME_YES -eq 0 && $TTY_IN -eq 1 ]]; then INTERACTIVE=1; fi

# ── sanity-only shortcut ─────────────────────────────────────────────────────
if [[ $SANITY_ONLY -eq 1 ]]; then MANTLE_ENV_FILE="$ENV_FILE" MANTLE_STACK_DIR="$STACK_DIR" MANTLE_COMPOSE_PROJECT="$COMPOSE_PROJECT" exec bash "$(dirname "$0")/sanity.sh"; fi

banner

# ── 1. preflight ─────────────────────────────────────────────────────────────
hd "Preflight"
command -v docker >/dev/null 2>&1 || die "Docker isn't installed. Install Docker Engine + Compose, then re-run."
docker info >/dev/null 2>&1 || die "Docker daemon isn't running. Start it, then re-run."
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin isn't available (need 'docker compose')."
command -v openssl >/dev/null 2>&1 || die "openssl isn't installed — it's needed to generate the master key + secrets."
command -v curl >/dev/null 2>&1 || die "curl isn't installed — it's needed to detect this server's address and to health-check the install."
[[ -f "$STACK_DIR/docker-compose.yml" ]] || die "No docker-compose.yml in $STACK_DIR — run this from the stack directory (or pass --stack-dir)."
ok "Docker + Compose ready ${DIM}($(docker compose version --short 2>/dev/null || echo v2))${RS}"

# Resources. Checked BEFORE the ~2 GB pull, because running out of disk
# halfway through leaves a half-populated image store and a confusing error;
# and a box that can't hold the working set will limp rather than fail, which
# is harder to diagnose than being told up front.
mkdir -p "$DATA_DIR" 2>/dev/null || true
avail_kb="$(df -Pk "$DATA_DIR" 2>/dev/null | awk 'NR==2{print $4}')"
if [[ -n "${avail_kb:-}" ]]; then
  avail_gb=$((avail_kb / 1024 / 1024))
  if   [[ $avail_gb -lt 5  ]]; then die "Only ${avail_gb}GB free on $DATA_DIR — the images alone need ~5GB. Free some space and re-run."
  elif [[ $avail_gb -lt 20 ]]; then warn "${avail_gb}GB free on $DATA_DIR — enough to install, but documents and backups grow into this. 20GB+ is comfortable."
  else ok "Disk: ${B}${avail_gb}GB${RS} free on $DATA_DIR"; fi
fi
mem_mb="$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || true)"
if [[ -n "${mem_mb:-}" ]]; then
  if   [[ $mem_mb -lt 3500 ]]; then warn "RAM: ${mem_mb}MB — below the 4GB the stack wants. Expect the workers to be killed under load."
  else ok "RAM: ${B}$((mem_mb / 1024))GB${RS}"; fi
fi
[[ -w "$STACK_DIR" ]] || warn "$STACK_DIR is not writable by $(id -un) — writing .env will fail."
inf "Stack dir: ${B}$STACK_DIR${RS}"
inf "Data dir:  ${B}$DATA_DIR${RS}  ${DIM}(all volumes bind here)${RS}"
if [[ $INTERACTIVE -eq 0 && $ASSUME_YES -eq 0 ]]; then
  warn "No terminal to prompt on — taking defaults. Pass --domain/--localhost/--lan to choose deliberately."
fi

# ── 2. how will people reach this brain? ─────────────────────────────────────
hd "Access"
detect_public_ip() {
  local ip=""
  ip=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null) \
    || ip=$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null) \
    || ip=""
  printf '%s' "$ip"
}
# ALL A/AAAA records, not just the first. Round-robin DNS and dual-stack
# records legitimately carry several addresses, and comparing only the first
# reports a confident false mismatch on a perfectly good setup.
# getent first (it honours the system's full resolution path), then dig/host as
# a fallback — getent answers through nsswitch, which a broken mDNS or an
# unusual hosts config can silence for one name while plain DNS works fine.
# Getting this wrong tells someone their DNS is broken when it isn't.
resolve_a() {
  local out=""
  # Loopback and link-local are never a certificate target — and an mDNS
  # answer will happily return a screenful of them.
  out="$(getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | grep -vE '^(127\.|169\.254\.)' | sort -u)"
  if [[ -z "$out" ]] && command -v dig >/dev/null 2>&1; then
    out="$(dig +short +time=3 +tries=1 "$1" A 2>/dev/null | grep -E '^[0-9.]+$' | sort -u)"
  fi
  if [[ -z "$out" ]] && command -v host >/dev/null 2>&1; then
    out="$(host -t A "$1" 2>/dev/null | awk '/has address/{print $NF}' | sort -u)"
  fi
  printf '%s' "$out"
}
resolve_aaaa() {
  local out=""
  out="$(getent ahostsv6 "$1" 2>/dev/null | awk '{print $1}' | grep -vE '^(::ffff:|fe80:|::1$)' | sort -u)"
  if [[ -z "$out" ]] && command -v dig >/dev/null 2>&1; then
    out="$(dig +short +time=3 +tries=1 "$1" AAAA 2>/dev/null | grep -E '^[0-9a-fA-F:]+$' | sort -u)"
  fi
  printf '%s' "$out"
}
# Take what people actually paste — https://brain.acme.com/, BRAIN.Acme.com,
# brain.acme.com:443, a trailing dot — and hand Caddy a bare hostname. A
# scheme or slash reaching the Caddyfile produces a site block that silently
# never matches.
normalize_host() {
  local h="$1"
  h="${h#*://}"; h="${h%%/*}"; h="${h%%\?*}"; h="${h%%:*}"; h="${h%.}"
  printf '%s' "$h" | tr '[:upper:]' '[:lower:]'
}
valid_host() {
  [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]
}
DNS_SEEN=""; DNS_VERDICT=""
# Sets globals rather than echoing a result: a `$(…)` call runs in a subshell,
# so the addresses collected there would never reach the caller and the
# "it resolves to …" line would come out blank exactly when it matters most.
dns_verdict() { # $1 = host → sets DNS_VERDICT (match|mismatch|none) + DNS_SEEN
  local ip l found="" n=0
  DNS_SEEN=""
  for ip in $(resolve_a "$1") $(resolve_aaaa "$1"); do
    n=$((n + 1))
    # Every address is compared; only the first few are printed. A round-robin
    # record can carry dozens, and a wall of them buries the actual answer.
    if   [[ $n -le 4 ]]; then DNS_SEEN+="${DNS_SEEN:+, }$ip"
    elif [[ $n -eq 5 ]]; then DNS_SEEN+=", …"; fi
    if [[ -n "$PUBLIC_IP" && "$ip" == "$PUBLIC_IP" ]]; then found=1; fi
    for l in $LOCAL_IPS; do if [[ "$ip" == "$l" ]]; then found=1; fi; done
  done
  if   [[ -z "$DNS_SEEN" ]]; then DNS_VERDICT="none"
  elif [[ -n "$found"   ]]; then DNS_VERDICT="match"
  else                            DNS_VERDICT="mismatch"; fi
}

PUBLIC_IP="$(detect_public_ip)"
LOCAL_IPS="$(hostname -I 2>/dev/null || true)"
# The address to advertise. `hostname -I` lists every interface in no
# guaranteed order, and a box with Docker has several bridge addresses in it —
# taking the first blindly can advertise 172.17.0.1 as the place to open, and
# bake it into MANTLE_SERVER_ORIGIN, which the browser uses as its API base.
# Prefer a real IPv4; fall back to any if that's all there is (a genuine
# 172.16/12 LAN).
LAN_IP="$(printf '%s\n' $LOCAL_IPS | grep -E '^[0-9]+\.' | grep -vE '^(127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | head -1 || true)"
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(printf '%s\n' $LOCAL_IPS | grep -E '^[0-9]+\.' | grep -vE '^(127\.|169\.254\.)' | head -1 || true)"
fi
if [[ -n "$PUBLIC_IP" ]]; then inf "This server looks like ${B}$PUBLIC_IP${RS} from the internet"; fi

# Pick the shape. Passing --site-address skips all of this deliberately.
if [[ -z "$SITE_ADDRESS" && -z "$ACCESS_MODE" ]]; then
  if [[ $INTERACTIVE -eq 1 ]]; then
    printf '\n  %sHow should people reach this brain?%s\n\n' "$B" "$RS"
    printf '    %s1%s  A domain, with HTTPS       %sbrain.example.com — a real server; the certificate issues itself%s\n' "$B$CYN" "$RS" "$DIM" "$RS"
    printf '    %s2%s  This machine only          %shttp://localhost — a laptop, or a box you tunnel into%s\n' "$B$CYN" "$RS" "$DIM" "$RS"
    printf "    %s3%s  This machine's network     %shttp://%s — LAN or VPN, no certificate%s\n" "$B$CYN" "$RS" "$DIM" "${LAN_IP:-<ip>}" "$RS"
    printf '\n'
    while :; do
      ask choice "Choice" "1"
      case "$choice" in
        1) ACCESS_MODE=domain;    break ;;
        2) ACCESS_MODE=localhost; break ;;
        3) ACCESS_MODE=lan;       break ;;
        *) warn "Pick 1, 2 or 3." ;;
      esac
    done
  else
    ACCESS_MODE=lan   # what a non-interactive run has always done
  fi
fi

# A domain is the only shape that can fail LATER and expensively — a wrong DNS
# record means Caddy hammers Let's Encrypt, fails, and counts against the
# rate limit for that name. So prove the record points here BEFORE we commit.
if [[ "$ACCESS_MODE" == domain && -z "$SITE_ADDRESS" ]]; then
  while :; do
    if [[ -z "$DOMAIN" ]]; then ask DOMAIN "Domain (e.g. brain.example.com):" ""; fi
    DOMAIN="$(normalize_host "$DOMAIN")"
    if [[ -z "$DOMAIN" ]] || ! valid_host "$DOMAIN"; then
      warn "That doesn't look like a hostname."
      DOMAIN=""
      if [[ $INTERACTIVE -eq 1 ]]; then continue; fi
      die "Pass a valid --domain, or use --localhost / --lan."
    fi
    step "Checking where $DOMAIN points…"
    dns_verdict "$DOMAIN"
    if [[ "$DNS_VERDICT" == match ]]; then
      ok "$DOMAIN → ${B}$DNS_SEEN${RS} — that's this server. Caddy will get a certificate on boot."
      SITE_ADDRESS="$DOMAIN"; break
    fi

    if [[ "$DNS_VERDICT" == none ]]; then
      bad "$DOMAIN doesn't resolve yet — no A or AAAA record."
    else
      bad "$DOMAIN points somewhere else."
      inf "   it resolves to  ${B}$DNS_SEEN${RS}"
      # Docker's own bridge gateways (172.x.0.1) are in `hostname -I` and are
      # pure noise here — still compared against, just not worth printing.
      shown="$(printf '%s\n' $LOCAL_IPS | grep -vE '^172\.(1[6-9]|2[0-9]|3[01])\.0\.1$' | paste -sd' ' - || true)"
      inf "   this server is  ${B}${PUBLIC_IP:-unknown}${RS}${shown:+ ${DIM}(local: $shown)${RS}}"
    fi
    inf "   ${DIM}A certificate cannot be issued until it points here, and failed attempts count against Let's Encrypt's limit for this name.${RS}"

    # Never proceed into a doomed certificate request unattended. The old
    # behaviour warned and then used the domain anyway.
    if [[ $INTERACTIVE -eq 0 ]]; then
      warn "Falling back to plain HTTP on :80. Fix the DNS and re-run with --domain $DOMAIN."
      ACCESS_MODE=lan; DOMAIN=""; break
    fi
    printf '\n    %s1%s  Re-check — I'"'"'m fixing the DNS now\n' "$B$CYN" "$RS"
    printf '    %s2%s  Start on plain HTTP for now %s(re-run with --domain once DNS is live)%s\n' "$B$CYN" "$RS" "$DIM" "$RS"
    printf '    %s3%s  Use a different domain\n' "$B$CYN" "$RS"
    printf '    %s4%s  Stop here\n\n' "$B$CYN" "$RS"
    ask what "Choice" "1"
    case "$what" in
      2) warn "Starting on HTTP :80 — re-run with --domain $DOMAIN once DNS is live."
         ACCESS_MODE=lan; DOMAIN=""; break ;;
      3) DOMAIN="" ;;
      4) die "Nothing changed. Point $DOMAIN at ${PUBLIC_IP:-this server} and run this again." ;;
      *) : ;;   # 1 / anything → loop and re-resolve
    esac
  done
fi

# HTTP-01 answers on port 80: if something else holds it, the certificate
# cannot issue no matter how correct the DNS is. Worth knowing now, not in
# Caddy's logs in ten minutes.
# ── the front door's host ports ───────────────────────────────────────────────
# A busy :80 is not a warning you can shrug off: Docker abandons a container's
# entire network setup when a published port won't bind, so the front door
# doesn't just lose the port — it comes up with no network and serves nothing.
#
# Whether we can move it depends on the mode. Without a certificate, any port
# works; you just open a different one. WITH a certificate we cannot move:
# Let's Encrypt answers HTTP-01 on port 80 and TLS-ALPN-01 on 443, both fixed
# by the ACME spec. Quietly shifting a domain install to 8080 would produce an
# install that can never get a certificate — success on screen, broken in fact.
free_port_from() { # $1 = first candidate, $2 = last → echoes a free one
  local p
  for p in $(seq "$1" "$2"); do
    if ! port_taken "$p"; then printf '%s' "$p"; return 0; fi
  done
  return 1
}
HTTP_PORT=80; HTTPS_PORT=443
# "Will Caddy try to get a certificate?" — not "did they pass --domain".
# A hostname in --site-address means auto-HTTPS just as surely, and moving the
# ports under it would produce the same never-issues-a-certificate install that
# domain mode refuses to build.
WANTS_CERT=0
if [[ "$ACCESS_MODE" == domain ]]; then WANTS_CERT=1; fi
if [[ -z "$ACCESS_MODE" && -n "$SITE_ADDRESS" && "$SITE_ADDRESS" != :* ]]; then WANTS_CERT=1; fi
CERT_HOST="${DOMAIN:-$SITE_ADDRESS}"

if port_taken 80 || port_taken 443; then
  busy_list=""
  if port_taken 80;  then busy_list="80"; fi
  if port_taken 443; then busy_list="${busy_list:+$busy_list and }443"; fi

  if [[ $WANTS_CERT -eq 1 ]]; then
    bad "Port $busy_list already in use — and a certificate can only be issued on 80 and 443."
    inf "   ${DIM}Let's Encrypt answers the challenge on those exact ports; moving them means no HTTPS.${RS}"
    inf "   ${DIM}Usually this is an existing nginx or apache already serving the box.${RS}"
    if [[ $INTERACTIVE -eq 0 ]]; then
      die "Free port $busy_list and re-run, or install behind your existing proxy: scripts/install.sh --behind-proxy --domain $CERT_HOST"
    fi
    printf '\n    %s1%s  Re-check — I'"'"'m freeing the port now\n' "$B$CYN" "$RS"
    printf '    %s2%s  Run behind the existing proxy %s(plain HTTP on a spare port; your proxy terminates TLS)%s\n' "$B$CYN" "$RS" "$DIM" "$RS"
    printf '    %s3%s  Stop here\n\n' "$B$CYN" "$RS"
    while :; do
      ask p80 "Choice" "1"
      case "$p80" in
        1) if port_taken 80 || port_taken 443; then warn "Still in use."; else ok "Ports 80 and 443 are free."; break; fi ;;
        2) ACCESS_MODE="proxy"; break ;;
        3) die "Nothing changed. Free port $busy_list, then run this again." ;;
        *) warn "Pick 1, 2 or 3." ;;
      esac
    done
  fi

  # No certificate to issue (or deliberately behind someone else's proxy) →
  # the port number doesn't matter, so just move.
  if [[ $WANTS_CERT -eq 0 || "$ACCESS_MODE" == proxy ]]; then
    if port_taken 80; then
      HTTP_PORT="$(free_port_from 8080 8099)" || die "Ports 80 and 8080-8099 are all in use — free one and re-run."
    fi
    if port_taken 443; then
      HTTPS_PORT="$(free_port_from 8443 8462)" || die "Ports 443 and 8443-8462 are all in use — free one and re-run."
    fi
    if [[ "$ACCESS_MODE" != proxy ]]; then
      warn "Port $busy_list already in use — serving on ${B}$HTTP_PORT${RS} instead."
    fi
  fi
fi

# Settle the three derived values every later step reads.
# Behind an existing proxy, :80 is the one port we must NOT take — that proxy
# owns it (or is about to). Move off it even when it happens to be free now.
if [[ "$ACCESS_MODE" == proxy && "$HTTP_PORT" == 80 ]]; then
  HTTP_PORT="$(free_port_from 8080 8099)" || die "Ports 8080-8099 are all in use — free one and re-run."
fi
if [[ "$ACCESS_MODE" == proxy && "$HTTPS_PORT" == 443 ]]; then
  HTTPS_PORT="$(free_port_from 8443 8462)" || die "Ports 8443-8462 are all in use — free one and re-run."
fi

# SITE_ADDRESS is what CADDY listens on inside its container — always :80 when
# there's no certificate to serve, whatever host port we publish it on.
BIND_ADDR="0.0.0.0"
PORT_SUFFIX=""
if [[ "$HTTP_PORT" != 80 ]]; then PORT_SUFFIX=":$HTTP_PORT"; fi
HOST_ADDR="${LAN_IP:-${PUBLIC_IP:-localhost}}"
case "$ACCESS_MODE" in
  domain)    SITE_ADDRESS="$DOMAIN";  OPEN_URL="https://$DOMAIN" ;;
  proxy)     SITE_ADDRESS=":80"; BIND_ADDR="127.0.0.1"
             OPEN_URL="${DOMAIN:+https://$DOMAIN}"; OPEN_URL="${OPEN_URL:-http://127.0.0.1$PORT_SUFFIX}" ;;
  localhost) SITE_ADDRESS=":80"; BIND_ADDR="127.0.0.1"; OPEN_URL="http://localhost$PORT_SUFFIX" ;;
  lan)       SITE_ADDRESS=":80";  OPEN_URL="http://$HOST_ADDR$PORT_SUFFIX" ;;
  *)         OPEN_URL="" ;;   # --site-address passed verbatim
esac
if [[ -z "${OPEN_URL:-}" ]]; then
  if [[ "$SITE_ADDRESS" == :* ]]; then OPEN_URL="http://$HOST_ADDR$PORT_SUFFIX"; else OPEN_URL="https://$SITE_ADDRESS"; fi
fi
case "$ACCESS_MODE" in
  domain)    ok "Site address: ${B}$SITE_ADDRESS${RS} ${DIM}(auto-HTTPS)${RS}" ;;
  proxy)     ok "Behind your proxy: Caddy serves plain HTTP on ${B}127.0.0.1:$HTTP_PORT${RS}"
             inf "Point the proxy that owns :443 at it, e.g. ${B}proxy_pass http://127.0.0.1:$HTTP_PORT;${RS}"
             inf "${DIM}Forward the Host header — the app builds links from it. Public address: $OPEN_URL${RS}" ;;
  localhost) ok "Site address: ${B}$OPEN_URL${RS} ${DIM}(bound to 127.0.0.1 — not reachable from the network)${RS}" ;;
  *)         ok "Site address: ${B}$OPEN_URL${RS} ${DIM}(HTTP, no certificate)${RS}" ;;
esac

# ── 2b. what to install ──────────────────────────────────────────────────────
# Every component choice used to be flag-only, which meant an interactive
# operator never saw it — the options may as well not have existed. Ask each
# one, with the cost stated where the answer is given, so choosing is informed
# rather than archaeological.
#
# Asked on a FRESH box only (same freshness rule as the generated DB secrets:
# no postgres data dir yet). A re-run keeps .env exactly as-is unless a flag
# says otherwise — an existing box must never flip a component because someone
# re-ran the installer to add a domain. Flags and MANTLE_* env always win over
# the questions (each question is skipped when its variable is already set).
FRESH_BOX=0
if [[ ! -d "$DATA_DIR/postgres" && ! -d "$STACK_DIR/data/postgres" ]]; then FRESH_BOX=1; fi
# An aborted first run may have left an .env full of answers with no database
# behind it yet — default each question to what was chosen last time, so
# hitting enter through the re-run keeps the earlier answers instead of
# silently reverting them. (getval proper is defined with the .env writers
# below; questions only need this read-side.)
envval() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
if [[ $INTERACTIVE -eq 1 && $FRESH_BOX -eq 1 ]]; then
  hd "What to install"
  # The shape first — it changes the right default for everything after it.
  if [[ -z "$CORE" ]]; then
    core_d=n
    if [[ "$(envval COMPOSE_FILE)" == *docker-compose.core.yml* ]]; then core_d=y; fi
    if [[ -n "${mem_mb:-}" && $mem_mb -lt 6000 ]]; then
      warn "This box has $((mem_mb / 1024))GB RAM — the full stack wants 8GB+. The small core shape is built for boxes like this."
      core_d=y
    fi
    inf "${DIM}Full = everything: chat, email/Telegram/calendar channels, background workers.${RS}"
    inf "${DIM}Core = a small headless memory core (HTTP API, MCP, share pages, file ingest, backups) that fits 2 vCPU / 4 GB.${RS}"
    if confirm "Install the SMALL core shape instead of the full stack?" "$core_d"; then CORE=1; else CORE=0; fi
  fi
  if [[ "$CORE" == 1 && -z "$HELPERS" ]]; then
    hlp_d=n; if [[ "$(envval COMPOSE_PROFILES)" == *helpers* ]]; then hlp_d=y; fi
    inf "${DIM}Doc helpers = tika (parses .odt/.pptx/.doc/.rtf — common formats parse without it) + the PDF-export browser (~2 GB image).${RS}"
    if confirm "Add the doc helpers to the core?" "$hlp_d"; then HELPERS=1; else HELPERS=0; fi
  fi
  if [[ -z "$SANDBOXES" ]]; then
    sbx_d=y; if [[ "$CORE" == 1 ]]; then sbx_d=n; fi
    if [[ "$(envval COMPOSE_PROFILES)" == *sandboxes* ]]; then sbx_d=y; fi
    inf "${DIM}CLI sandboxes give the coder agent isolated containers to work in (docs/sandboxes.md). One extra service + a base image pull.${RS}"
    if confirm "Enable CLI sandboxes?" "$sbx_d"; then SANDBOXES=1; else SANDBOXES=0; fi
  fi
  if [[ -z "$LOCAL_EMBEDDER" ]]; then
    emb_d=n; if [[ "$(envval COMPOSE_PROFILES)" == *local-embedder* ]]; then emb_d=y; fi
    if [[ -n "${mem_mb:-}" && $mem_mb -lt 15000 ]]; then
      inf "${DIM}Local embedder (Ollama + EmbeddingGemma, ~3.3 GB): needs a LARGE box — it degrades a 16GB/8-core server under multi-file ingest. This box is smaller; online embeddings (set up in onboarding) are the right choice here.${RS}"
    else
      inf "${DIM}Local embedder (Ollama + EmbeddingGemma, ~3.3 GB image + model): embeddings never leave the box. Skip it to use online embeddings, chosen during onboarding.${RS}"
    fi
    if confirm "Bundle the LOCAL embedder?" "$emb_d"; then LOCAL_EMBEDDER=1; else LOCAL_EMBEDDER=0; fi
  fi
  if [[ -z "$CLIENT" ]]; then
    cli_d=y; if [[ "$(envval MANTLE_CLIENT_ENABLED)" == 0 ]]; then cli_d=n; fi
    inf "${DIM}The owner web UI is a separate small container — signup and every owner screen live in it. Skip it only for a headless memory core driven over MCP/API.${RS}"
    if confirm "Run the owner web UI?" "$cli_d"; then CLIENT=1; else CLIENT=0; fi
  fi
elif [[ $INTERACTIVE -eq 1 ]]; then
  inf "Existing install — components stay as configured. ${DIM}(Change with --core/--sandboxes/--local-embedder/--helpers/--no-client; see --help.)${RS}"
fi

# ── 3. secrets + .env ────────────────────────────────────────────────────────
hd "Configuration (.env)"
getval() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
upsert() { # KEY VALUE — replace-in-place or append; preserves other lines
  local k="$1" v="$2" tmp
  touch "$ENV_FILE"
  if grep -qE "^${k}=" "$ENV_FILE" 2>/dev/null; then
    # `|| true`: grep -v exits 1 when the key is the ONLY line — not an error.
    tmp="$(mktemp)"; grep -vE "^${k}=" "$ENV_FILE" > "$tmp" || true
    printf '%s=%s\n' "$k" "$v" >> "$tmp"; mv "$tmp" "$ENV_FILE"
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
# POSTGRES_PASSWORD: generate ONLY for a genuinely fresh database. An older
# install may have no POSTGRES_PASSWORD line yet an initialized data dir
# (password baked in at initdb) — generating one there would break DB auth.
if [[ -n "$(getval POSTGRES_PASSWORD)" ]]; then
  ensure POSTGRES_PASSWORD "gen_hex 16"   # present → kept as-is
elif [[ ! -d "$DATA_DIR/postgres" && ! -d "$STACK_DIR/data/postgres" ]]; then
  ensure POSTGRES_PASSWORD "gen_hex 16"   # fresh box → strong generated password
else
  warn "POSTGRES_PASSWORD not set but a postgres data dir exists — leaving it on the compose default (matches how the DB was initialised)."
fi
# Same fresh-only rule for the object-store credentials (MinIO bakes its root
# user/password in at first start, exactly like postgres).
if [[ -n "$(getval S3_SECRET_KEY)" ]]; then
  ensure S3_ACCESS_KEY   "gen_hex 12"
  ensure S3_SECRET_KEY   "gen_hex 24"
elif [[ ! -d "$DATA_DIR/minio" && ! -d "$STACK_DIR/data/minio" ]]; then
  ensure S3_ACCESS_KEY   "gen_hex 12"
  ensure S3_SECRET_KEY   "gen_hex 24"
else
  warn "S3 keys not set but a minio data dir exists — leaving them on the compose defaults (matches how the object store was initialised)."
fi
upsert MANTLE_SITE_ADDRESS "$SITE_ADDRESS"
# Which interface the front door listens on. 127.0.0.1 for a "this machine
# only" install — a published Docker port bypasses the host firewall (Docker
# writes its own DNAT rules), so binding loopback is the only thing that
# actually keeps a laptop brain off the network.
upsert MANTLE_BIND_ADDR "$BIND_ADDR"
upsert MANTLE_HTTP_PORT  "$HTTP_PORT"
upsert MANTLE_HTTPS_PORT "$HTTPS_PORT"
# Public origin for share/email links + the onboarding Domain check. Only
# meaningful when a real hostname is set; without one, links would embed an
# address that may change, so it stays unset until a domain is added.
if [[ "$ACCESS_MODE" == domain || "$ACCESS_MODE" == proxy ]]; then
  upsert MANTLE_PUBLIC_URL "https://$DOMAIN"
elif [[ "$SITE_ADDRESS" != :* ]]; then
  upsert MANTLE_PUBLIC_URL "https://$SITE_ADDRESS"
fi
# The owner UI is its OWN app since the v0.200 split, and it reaches the API
# over HTTP — so it needs an absolute origin even in the same-origin shape we
# install by default (the browser sees one domain; the client's server-side
# render does not). Without this a fresh install comes up with the server
# stack only and the visitor lands on a "this has moved" card, unable to sign
# up at all — signup lives in the client app.
#
# It must be the origin THE BROWSER can reach: the client app serves this value
# to the page as `apiBase` (client/web/app/env.js), so every API call the
# browser makes is built from it. A hardcoded "http://localhost" is right only
# when you're browsing from the box itself — on a network install it sends a
# remote browser to its OWN machine. So it tracks the address we actually tell
# people to open, port and all.
upsert MANTLE_SERVER_ORIGIN "$OPEN_URL"
upsert MANTLE_DATA_DIR     "$DATA_DIR"
upsert MANTLE_STACK_DIR    "$STACK_DIR"
upsert MANTLE_IMAGE_TAG    "$IMAGE_TAG"
# ── web debug port ───────────────────────────────────────────────────────────
# The web container publishes 127.0.0.1:<port>:3000 purely for on-host
# debugging — Caddy reaches the app over the internal network and never needs
# it. But a busy host port is NOT a cosmetic loss: Docker aborts the whole
# network setup for that container, and it comes up attached to no network at
# all — no postgres, no service discovery — while still reporting healthy. A
# leftover stack or a `next dev` on :3000 is enough. So pick a free port here
# rather than hand the user an opaque bind error (or a silently dead app).
DEBUG_PORT="$(getval MANTLE_WEB_DEBUG_PORT)"; DEBUG_PORT="${DEBUG_PORT:-3000}"
if port_taken "$DEBUG_PORT"; then
  free_port=""
  for p in $(seq 3000 3020); do
    if ! port_taken "$p"; then free_port="$p"; break; fi
  done
  if [[ -n "$free_port" ]]; then
    warn "Port $DEBUG_PORT is already in use — using ${B}$free_port${RS} for the local debug tunnel instead."
    inf "Nothing is lost: the app is served by Caddy, not this port. Reach it on-host at ${B}http://127.0.0.1:$free_port${RS}."
    DEBUG_PORT="$free_port"
  else
    warn "Ports 3000-3020 are all in use — the web container's debug port cannot be published."
    warn "Free one and re-run: an unpublishable port makes Docker drop the container's network entirely."
  fi
fi
upsert MANTLE_WEB_DEBUG_PORT "$DEBUG_PORT"
# ── Local embedder (bundled Ollama + EmbeddingGemma, ~3.3GB image+model) ─────
# OPT-IN via the `local-embedder` compose profile, persisted in
# COMPOSE_PROFILES so every later `docker compose pull/up` — the updater
# included — keeps honouring the choice. Off (the default) means the ollama
# services are never pulled, never started, and no model is downloaded.
# Flag not passed → keep whatever .env already has (re-runs never flip it).
if [[ -n "$LOCAL_EMBEDDER" ]]; then
  # Preserve any other profiles; add/remove just ours.
  rest="$(getval COMPOSE_PROFILES | tr ',' '\n' | grep -vx 'local-embedder' | grep -v '^$' | paste -sd, -)" || rest=""
  if [[ "$LOCAL_EMBEDDER" == 1 ]]; then
    upsert COMPOSE_PROFILES "${rest:+$rest,}local-embedder"
    ok "Local embedder ON — ollama will pull + start with the stack"
  else
    if [[ -n "$rest" ]]; then
      upsert COMPOSE_PROFILES "$rest"
    elif grep -qE '^COMPOSE_PROFILES=' "$ENV_FILE" 2>/dev/null; then
      tmp="$(mktemp)"; grep -vE '^COMPOSE_PROFILES=' "$ENV_FILE" > "$tmp"; mv "$tmp" "$ENV_FILE"
    fi
    # Best-effort: stop + remove the containers (images/model cache stay).
    docker compose --env-file "$ENV_FILE" --project-directory "$STACK_DIR" \
      --profile local-embedder rm -sf ollama ollama_pull >/dev/null 2>&1 || true
    ok "Local embedder OFF — ollama will not be pulled or started"
  fi
fi
# ── Brain-core shape (small headless memory core) ────────────────────────────
# Persisted via COMPOSE_FILE in .env: compose (and the updater sidecar) load
# docker-compose.core.yml as an override that gates the channel workers + the
# PDF-export browser behind a `full` profile — see that file's header for the
# exact service split. Paths are ABSOLUTE on purpose: the updater runs compose
# from cwd=/, and a relative COMPOSE_FILE resolves against cwd, not the stack
# dir (verified against the docker:28-cli compose). COMPOSE_PROFILES stays
# untouched — a core can still opt into local-embedder etc.
# Flag not passed → keep whatever .env already has (re-runs never flip it).
if [[ -n "$CORE" ]]; then
  if [[ "$CORE" == 1 ]]; then
    [[ -f "$STACK_DIR/docker-compose.core.yml" ]] \
      || die "docker-compose.core.yml missing from $STACK_DIR — re-download the deploy bundle (--core needs it)."
    upsert COMPOSE_FILE "$STACK_DIR/docker-compose.yml:$STACK_DIR/docker-compose.core.yml"
    # Best-effort: stop + remove the services the core sheds (a fresh box has
    # none of them yet; a downsized box drops them here). Naming a service
    # explicitly overrides its profile gate, so this works post-COMPOSE_FILE.
    # The doc helpers (tika + browser) are only shed when the helpers profile
    # isn't active — the --helpers block below runs after this one.
    SHED="worker_email worker_telegram worker_microsoft worker_calendar worker_push worker_runs"
    if [[ "$HELPERS" != 1 && "$(getval COMPOSE_PROFILES)" != *helpers* ]]; then SHED="tika browser $SHED"; fi
    # shellcheck disable=SC2086  # word-splitting $SHED into args is intended
    docker compose --env-file "$ENV_FILE" --project-directory "$STACK_DIR" \
      rm -sf $SHED >/dev/null 2>&1 || true
    ok "Brain-core shape ON — channel workers + doc helpers won't start (see docker-compose.core.yml)"
  else
    if [[ "$(getval COMPOSE_FILE)" == *docker-compose.core.yml* ]]; then
      tmp="$(mktemp)"; grep -vE '^COMPOSE_FILE=' "$ENV_FILE" > "$tmp"; mv "$tmp" "$ENV_FILE"
      ok "Brain-core shape OFF — the full service set starts on the next 'docker compose up -d'"
    elif [[ -n "$(getval COMPOSE_FILE)" ]]; then
      warn "COMPOSE_FILE in .env is not the core shape — leaving your custom value alone."
    fi
  fi
fi
# ── Doc helpers (tika + PDF-export browser) on the core shape ────────────────
# Persisted via COMPOSE_PROFILES exactly like the embedder. Only meaningful
# when the core override is active (the full shape runs both unconditionally),
# but writing the profile on a full box is harmless — it simply pre-arms the
# choice for a later --core. Flag not passed → keep .env as-is.
if [[ -n "$HELPERS" ]]; then
  rest="$(getval COMPOSE_PROFILES | tr ',' '\n' | grep -vx 'helpers' | grep -v '^$' | paste -sd, -)" || rest=""
  if [[ "$HELPERS" == 1 ]]; then
    upsert COMPOSE_PROFILES "${rest:+$rest,}helpers"
    ok "Doc helpers ON — tika + the PDF-export browser start with the stack"
  else
    if [[ -n "$rest" ]]; then
      upsert COMPOSE_PROFILES "$rest"
    elif grep -qE '^COMPOSE_PROFILES=' "$ENV_FILE" 2>/dev/null; then
      tmp="$(mktemp)"; grep -vE '^COMPOSE_PROFILES=' "$ENV_FILE" > "$tmp"; mv "$tmp" "$ENV_FILE"
    fi
    # Best-effort stop, but ONLY on the core shape — on a full box these two
    # are always-on services and must not be touched.
    if [[ "$(getval COMPOSE_FILE)" == *docker-compose.core.yml* ]]; then
      docker compose --env-file "$ENV_FILE" --project-directory "$STACK_DIR" \
        rm -sf tika browser >/dev/null 2>&1 || true
    fi
    ok "Doc helpers OFF — tika + the PDF-export browser won't start on the core shape"
  fi
fi
# ── Owner web UI (the separate client stack) ─────────────────────────────────
# Persisted as MANTLE_CLIENT_ENABLED so the bring-up below, the updater's
# client roll and the sanity check all read ONE switch. Missing from .env
# means ON — every box installed before this flag existed runs the UI and
# must keep doing so. Flag not passed → keep .env as-is.
if [[ -n "$CLIENT" ]]; then
  if [[ "$CLIENT" == 1 ]]; then
    upsert MANTLE_CLIENT_ENABLED 1
    ok "Owner web UI ON"
  else
    upsert MANTLE_CLIENT_ENABLED 0
    # Best-effort: stop + remove a running client container (its image stays).
    if [[ -f "$STACK_DIR/docker-compose.client.yml" ]]; then
      docker compose --env-file "$ENV_FILE" --project-directory "$STACK_DIR" \
        -f "$STACK_DIR/docker-compose.client.yml" rm -sf client-web >/dev/null 2>&1 || true
    fi
    ok "Owner web UI OFF — headless: API + MCP + share pages only (no signup screen)"
  fi
fi
if [[ -n "$CLIENT_TAG" ]]; then
  upsert MANTLE_CLIENT_IMAGE_TAG "$CLIENT_TAG"
  ok "Owner UI image pinned to ${B}$CLIENT_TAG${RS}"
fi
# ── CLI sandboxes (sandboxd + isolated sandbox networks) ─────────────────────
# Part of the system on NEW boxes: defaults ON for a genuinely fresh install
# (same freshness rule as the generated DB secrets — no postgres data dir yet).
# A re-run on an existing box never flips the choice implicitly; enable there
# with --sandboxes, opt out anywhere with --no-sandboxes. Persisted via
# COMPOSE_PROFILES exactly like the embedder, so the updater keeps it running.
if [[ -z "$SANDBOXES" && ! -d "$DATA_DIR/postgres" && ! -d "$STACK_DIR/data/postgres" ]]; then
  # …except on a core box: sandboxes are a full-shape luxury a 4 GB memory
  # core shouldn't carry by default (explicit --sandboxes still wins above).
  if [[ "$CORE" == 1 || "$(getval COMPOSE_FILE)" == *docker-compose.core.yml* ]]; then
    inf "Core shape — CLI sandboxes stay OFF (enable with --sandboxes)"
  else
    SANDBOXES=1
    inf "Fresh install — CLI sandboxes default ON (skip with --no-sandboxes)"
  fi
fi
if [[ -n "$SANDBOXES" ]]; then
  rest="$(getval COMPOSE_PROFILES | tr ',' '\n' | grep -vx 'sandboxes' | grep -v '^$' | paste -sd, -)" || rest=""
  if [[ "$SANDBOXES" == 1 ]]; then
    upsert COMPOSE_PROFILES "${rest:+$rest,}sandboxes"
    ensure SANDBOXD_TOKEN "gen_hex 32"    # bearer between web/api and sandboxd; never rotated on re-run
    if [[ -z "$(getval MANTLE_SANDBOXES_HOST_DIR)" ]]; then
      # HOST-absolute is a hard requirement: sandboxd hands this path to the
      # host docker daemon as a bind source (and is itself mounted at the same
      # path). Resolve a relative data dir against the stack dir.
      SBX_DIR="$DATA_DIR"
      [[ "$SBX_DIR" != /* ]] && SBX_DIR="$STACK_DIR/${SBX_DIR#./}"
      upsert MANTLE_SANDBOXES_HOST_DIR "$SBX_DIR/sandboxes"
    fi
    ok "CLI sandboxes ON — sandboxd starts with the stack (coder agent, docs/sandboxes.md)"
  else
    if [[ -n "$rest" ]]; then
      upsert COMPOSE_PROFILES "$rest"
    elif grep -qE '^COMPOSE_PROFILES=' "$ENV_FILE" 2>/dev/null; then
      tmp="$(mktemp)"; grep -vE '^COMPOSE_PROFILES=' "$ENV_FILE" > "$tmp"; mv "$tmp" "$ENV_FILE"
    fi
    # Best-effort: stop + remove sandboxd (sandbox /files dirs stay untouched).
    docker compose --env-file "$ENV_FILE" --project-directory "$STACK_DIR" \
      --profile sandboxes rm -sf sandboxd >/dev/null 2>&1 || true
    ok "CLI sandboxes OFF — sandboxd will not start"
  fi
fi
chmod 600 "$ENV_FILE" 2>/dev/null || true
ok "Wrote ${B}$ENV_FILE${RS} ${DIM}(chmod 600)${RS}"

if [[ $SKIP_UP -eq 1 ]]; then hd "Done (--skip-up)"; inf "Config written; stack not started. Bring it up with: ${B}docker compose up -d --wait${RS}"; exit 0; fi

# 80 and 443 were both settled with the access mode above, where the advice can
# be specific and the port can still be changed.

# ── 3b. front door: route BOTH apps on one domain ────────────────────────────
# Since v0.200 Mantle is two images — the server (API + share/print surfaces)
# and the zero-secret owner UI. A fresh install uses the SAME-ORIGIN shape:
# one domain, path-routed, no second DNS record and no CORS. The shipped
# default Caddyfile expects a separate app.<domain> vhost, so swap it.
if [[ -f "$STACK_DIR/infra/caddy/Caddyfile.same-origin" ]]; then
  cp "$STACK_DIR/infra/caddy/Caddyfile.same-origin" "$STACK_DIR/infra/caddy/Caddyfile"
  ok "Front door configured (same-origin: one domain serves both apps)"
else
  warn "infra/caddy/Caddyfile.same-origin missing — the front door may not route the owner UI. Re-download the deploy bundle."
fi

# ── 3c. review ───────────────────────────────────────────────────────────────
# The last cheap moment to catch a wrong answer. After this we pull ~2 GB and
# initialise a database whose credentials are baked in at first start.
hd "Review"
row() { printf '  %s%-16s%s %s\n' "$DIM" "$1" "$RS" "$2"; }
case "$ACCESS_MODE" in
  domain)    row "Reachable at" "${B}https://$DOMAIN${RS}  ${DIM}certificate issues on first boot${RS}" ;;
  proxy)     row "Reachable at" "${B}$OPEN_URL${RS}  ${DIM}via your proxy → 127.0.0.1:$HTTP_PORT${RS}" ;;
  localhost) row "Reachable at" "${B}$OPEN_URL${RS}  ${DIM}this machine only${RS}" ;;
  *)         row "Reachable at" "${B}$OPEN_URL${RS}  ${DIM}HTTP, no certificate${RS}" ;;
esac
if [[ "$HTTP_PORT" != 80 ]]; then
  row "Front door" "host ${B}$HTTP_PORT${RS} → :80  ${DIM}(80 was taken)${RS}"
fi
row "Data"        "$DATA_DIR  ${DIM}(documents, database, backups)${RS}"
row "Stack"       "$STACK_DIR"
row "Version"     "$IMAGE_TAG"
row "Embedder"    "$(if [[ "$(getval COMPOSE_PROFILES)" == *local-embedder* ]]; then printf 'bundled (local)'; else printf 'online — chosen during onboarding'; fi)"
row "Shape"       "$(if [[ "$(getval COMPOSE_FILE)" == *docker-compose.core.yml* ]]; then if [[ "$(getval COMPOSE_PROFILES)" == *helpers* ]]; then printf 'core + doc helpers (channel workers off)'; else printf 'core (channel workers + doc helpers off)'; fi; else printf 'full'; fi)"
row "Sandboxes"   "$(if [[ "$(getval COMPOSE_PROFILES)" == *sandboxes* ]]; then printf 'on (coder agent gets isolated containers)'; else printf 'off'; fi)"
row "Owner UI"    "$(if [[ "$(getval MANTLE_CLIENT_ENABLED)" == 0 ]]; then printf 'off — headless (MCP / API only)'; else printf 'on (tag: %s)' "$(getval MANTLE_CLIENT_IMAGE_TAG | grep . || echo latest)"; fi)"
if [[ "$DEBUG_PORT" != 3000 ]]; then row "Debug port" "127.0.0.1:$DEBUG_PORT  ${DIM}(3000 was taken)${RS}"; fi
existing="$(docker ps -aq --filter "label=com.docker.compose.project=mantle" 2>/dev/null | head -1)"
if [[ -n "$existing" ]]; then
  row "Existing stack" "${YLW}found — this is an update, not a fresh install${RS}"
  inf "${DIM}Your data and master key are kept; containers are recreated.${RS}"
fi
printf '\n'
if ! confirm "Go ahead?" y; then die "Stopped. $ENV_FILE is written — re-run when you're ready, or use --skip-up."; fi

# ── 4. bring the stack up ────────────────────────────────────────────────────
hd "Starting the stack"
STARTED_AT=$SECONDS
COMPOSE=(docker compose --env-file "$ENV_FILE" --project-directory "$STACK_DIR")
CLIENT_COMPOSE=(docker compose --env-file "$ENV_FILE" --project-directory "$STACK_DIR" -f "$STACK_DIR/docker-compose.client.yml")
inf "Pulling images (tag: ${B}$IMAGE_TAG${RS}) — a first install downloads ~2 GB…"
"${COMPOSE[@]}" pull -q 2>&1 | sed 's/^/    /' \
  || warn "Image pull failed. If the image is private, run 'docker login <registry>' and re-run. Continuing so the sanity check can report."

# Pre-pull the sandbox BASE image when the profile is on. It's not a compose
# service (sandboxd creates sandboxes from it ad hoc), so `compose pull` never
# fetches it — without this the coder agent's first sandbox_create stalls on a
# multi-hundred-MB download.
if getval COMPOSE_PROFILES | tr ',' '\n' | grep -qx 'sandboxes'; then
  SBX_IMAGE="$(getval SANDBOX_DEFAULT_IMAGE)"
  SBX_IMAGE="${SBX_IMAGE:-titanwest/mantle-sandbox:24.04-v2}"
  inf "Pre-pulling the sandbox base image (${B}$SBX_IMAGE${RS})…"
  docker pull -q "$SBX_IMAGE" 2>&1 | sed 's/^/    /' \
    || warn "Sandbox base image pull failed — the first sandbox_create will pull it instead."
fi
inf "Bringing services up (waits for migrate + health)…"
"${COMPOSE[@]}" up -d --wait || warn "up --wait returned non-zero — the sanity check below will show what's wrong."

# The owner UI — a SEPARATE stack on its own version stream (jackdaw-built;
# pinned by MANTLE_CLIENT_IMAGE_TAG, default `latest`).
# Skipping this leaves a brain with no usable interface: signup and every
# owner screen live here — which is exactly what a deliberate --no-client box
# wants, and an accident everywhere else. MANTLE_CLIENT_ENABLED=0 is the one
# switch; missing means ON.
if [[ "$(getval MANTLE_CLIENT_ENABLED)" == 0 ]]; then
  inf "Owner web UI disabled (MANTLE_CLIENT_ENABLED=0) — headless brain: no signup screen; drive it over MCP / the API."
elif [[ -f "$STACK_DIR/docker-compose.client.yml" ]]; then
  inf "Bringing up the owner UI (client app)…"
  "${CLIENT_COMPOSE[@]}" pull -q 2>&1 | sed 's/^/    /' || warn "Client image pull failed — the owner UI will not start."
  "${CLIENT_COMPOSE[@]}" up -d --wait || warn "Client app did not become healthy — check 'docker logs mantle_client_web'."
  # Caddy is already running from the step above with the OLD routing table;
  # reload it now that the client container exists to proxy to.
  "${COMPOSE[@]}" up -d --force-recreate caddy >/dev/null 2>&1 \
    || warn "Could not recreate Caddy — run: docker compose up -d --force-recreate caddy"
else
  warn "docker-compose.client.yml missing — the owner UI cannot start. Re-download the deploy bundle."
fi

# ── 5. sanity check ──────────────────────────────────────────────────────────
# Its verdict is THE verdict. Printing a cheerful "complete" over a failed
# check is how a dead install came to be reported as a working one — and a
# scripted deploy needs the exit code to say so too.
SANITY_RC=0
MANTLE_ENV_FILE="$ENV_FILE" MANTLE_STACK_DIR="$STACK_DIR" MANTLE_COMPOSE_PROJECT="$COMPOSE_PROJECT" bash "$(dirname "$0")/sanity.sh" || SANITY_RC=$?

if [[ $SANITY_RC -ne 0 ]]; then
  hd "Installation incomplete"
  bad "The checks above didn't pass — don't expect $OPEN_URL to answer yet."
  inf "Most of it is usually up; fix what's flagged and re-check:"
  inf "  ${B}scripts/install.sh --check${RS}"
  inf "  ${B}docker compose logs --tail 50 web caddy${RS}"
  printf '  %s•%s Took %ss.\n' "$BLU" "$RS" "$((SECONDS - STARTED_AT))"
  exit 1
fi

hd "Installation complete"
inf "Open ${B}$OPEN_URL${RS} and create your account — onboarding starts there."
if [[ "$ACCESS_MODE" == domain ]]; then
  inf "${DIM}The certificate is issued on the first request; the first load can take a few seconds.${RS}"
elif [[ "$ACCESS_MODE" == localhost ]]; then
  inf "${DIM}Bound to 127.0.0.1 — from another machine, tunnel in: ssh -L 8080:localhost:80 $(id -un)@<this-host>${RS}"
fi
inf "Data lives in ${B}$DATA_DIR${RS} — that directory is the backup."
inf "Re-check health any time: ${B}scripts/install.sh --check${RS}"
printf '  %s•%s Took %ss.\n' "$BLU" "$RS" "$((SECONDS - STARTED_AT))"
