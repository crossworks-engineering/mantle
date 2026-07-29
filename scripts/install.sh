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
if [[ -r /dev/tty ]] && exec 3</dev/tty 2>/dev/null; then TTY_IN=1; fi
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
usage() {
  cat <<EOF
${B}Mantle installer${RS}

  scripts/install.sh [options]

${B}Options${RS}
  --domain <host>        Use this domain (enables HTTPS via Caddy/Let's Encrypt)
  --localhost            This machine only — HTTP on 127.0.0.1:80, not on the network
  --lan                  HTTP on :80, reachable on this machine's network (no TLS)
  --no-domain            Alias for --lan (kept for existing scripts)
  --site-address <addr>  Set MANTLE_SITE_ADDRESS verbatim (advanced; overrides above)
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
  --domain) DOMAIN="${2:-}"; ACCESS_MODE="domain"; shift 2 ;;
  --localhost) ACCESS_MODE="localhost"; shift ;;
  --lan|--no-domain) ACCESS_MODE="lan"; shift ;;
  --site-address) SITE_ADDRESS="${2:-}"; shift 2 ;;
  --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
  --stack-dir) STACK_DIR="${2:-}"; shift 2 ;;
  --image-tag) IMAGE_TAG="${2:-}"; shift 2 ;;
  --local-embedder) LOCAL_EMBEDDER=1; shift ;;
  --no-local-embedder) LOCAL_EMBEDDER=0; shift ;;
  -y|--yes|--non-interactive) ASSUME_YES=1; shift ;;
  --skip-up) SKIP_UP=1; shift ;;
  --sanity|--check) SANITY_ONLY=1; shift ;;
  -h|--help) usage; exit 0 ;;
  *) die "unknown argument: $1  (try --help)" ;;
esac; done

ENV_FILE="$STACK_DIR/.env"
# Prompt only when there is someone to answer AND they didn't ask us not to.
# (`if`, not `[[ … ]] && …` — under `set -e` a false one-liner ends the script.)
if [[ $ASSUME_YES -eq 0 && $TTY_IN -eq 1 ]]; then INTERACTIVE=1; fi

# ── sanity-only shortcut ─────────────────────────────────────────────────────
if [[ $SANITY_ONLY -eq 1 ]]; then exec bash "$(dirname "$0")/sanity.sh"; fi

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
LAN_IP="$(printf '%s' "$LOCAL_IPS" | awk '{print $1}')"
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
if port_busy 80; then
  if [[ "$ACCESS_MODE" == domain ]]; then
    warn "Port 80 is already in use — Caddy needs it both to serve and to answer the certificate challenge."
  else
    warn "Port 80 is already in use — Caddy needs it to serve the app."
  fi
  warn "Stop whatever holds it (often an existing nginx or apache), or this install won't be reachable."
fi

# Settle the three derived values every later step reads.
BIND_ADDR="0.0.0.0"
case "$ACCESS_MODE" in
  domain)    SITE_ADDRESS="$DOMAIN";  OPEN_URL="https://$DOMAIN" ;;
  localhost) SITE_ADDRESS=":80"; BIND_ADDR="127.0.0.1"; OPEN_URL="http://localhost" ;;
  lan)       SITE_ADDRESS=":80";  OPEN_URL="http://${LAN_IP:-${PUBLIC_IP:-<server-ip>}}" ;;
  *)         OPEN_URL="" ;;   # --site-address passed verbatim
esac
if [[ -z "${OPEN_URL:-}" ]]; then
  if [[ "$SITE_ADDRESS" == :* ]]; then OPEN_URL="http://${LAN_IP:-localhost}"; else OPEN_URL="https://$SITE_ADDRESS"; fi
fi
case "$ACCESS_MODE" in
  domain)    ok "Site address: ${B}$SITE_ADDRESS${RS} ${DIM}(auto-HTTPS)${RS}" ;;
  localhost) ok "Site address: ${B}http://localhost${RS} ${DIM}(bound to 127.0.0.1 — not reachable from the network)${RS}" ;;
  *)         ok "Site address: ${B}$OPEN_URL${RS} ${DIM}(HTTP :80, no certificate)${RS}" ;;
esac

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
# Public origin for share/email links + the onboarding Domain check. Only
# meaningful when a real hostname is set; on :80 (no domain) links would embed
# an address that may change, so it stays unset until a domain is added.
if [[ "$SITE_ADDRESS" != :* ]]; then
  upsert MANTLE_PUBLIC_URL "https://$SITE_ADDRESS"
fi
# The owner UI is its OWN app since the v0.200 split, and it reaches the API
# over HTTP — so it needs an absolute origin even in the same-origin shape we
# install by default (the browser sees one domain; the client's server-side
# render does not). Without this a fresh install comes up with the server
# stack only and the visitor lands on a "this has moved" card, unable to sign
# up at all — signup lives in the client app.
if [[ "$SITE_ADDRESS" == :* ]]; then
  upsert MANTLE_SERVER_ORIGIN "http://localhost"
else
  upsert MANTLE_SERVER_ORIGIN "https://$SITE_ADDRESS"
fi
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
if port_busy "$DEBUG_PORT"; then
  free_port=""
  for p in $(seq 3000 3020); do
    if ! port_busy "$p"; then free_port="$p"; break; fi
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
chmod 600 "$ENV_FILE" 2>/dev/null || true
ok "Wrote ${B}$ENV_FILE${RS} ${DIM}(chmod 600)${RS}"

if [[ $SKIP_UP -eq 1 ]]; then hd "Done (--skip-up)"; inf "Config written; stack not started. Bring it up with: ${B}docker compose up -d --wait${RS}"; exit 0; fi

# Port 80 was checked with the access mode above, where the advice can be
# specific. 443 only matters once there's a certificate to serve.
if [[ "$ACCESS_MODE" == domain ]] && port_busy 443; then
  warn "Port 443 is already in use — Caddy needs it to serve HTTPS."
fi

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
  localhost) row "Reachable at" "${B}http://localhost${RS}  ${DIM}this machine only${RS}" ;;
  *)         row "Reachable at" "${B}$OPEN_URL${RS}  ${DIM}HTTP, no certificate${RS}" ;;
esac
row "Data"        "$DATA_DIR  ${DIM}(documents, database, backups)${RS}"
row "Stack"       "$STACK_DIR"
row "Version"     "$IMAGE_TAG"
row "Embedder"    "$(if [[ "$(getval COMPOSE_PROFILES)" == *local-embedder* ]]; then printf 'bundled (local)'; else printf 'online — chosen during onboarding'; fi)"
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
inf "Bringing services up (waits for migrate + health)…"
"${COMPOSE[@]}" up -d --wait || warn "up --wait returned non-zero — the sanity check below will show what's wrong."

# The owner UI — a SEPARATE stack on the same tag (releases are lockstep).
# Skipping this leaves a brain with no usable interface: signup and every
# owner screen live here.
if [[ -f "$STACK_DIR/docker-compose.client.yml" ]]; then
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
bash "$(dirname "$0")/sanity.sh" || SANITY_RC=$?

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
