#!/usr/bin/env bash
# runs-on: mac. A dev or operator machine, the Mac included: keep it bash 3.2 and BSD-tool safe.
#
# sso-env.sh: set a box's company sign-in lines in its .env from one place,
# then recreate the stack and check that web runs with them.
#
# The issuer, the client id and the mode stay in the box's .env on purpose
# (docs/oidc-sign-in.md, decision D2): who sets the issuer decides who can
# sign in, so no app route and no API key may change it. This script is the
# central path: the operator runs it from their own machine over ssh. The
# client secret never passes through it; the box admin enters that on
# Settings > Company sign-in (setup mode).
#
#   scripts/sso-env.sh [--dry-run] [--no-up] <box-label> --tenant <id> --client <id>
#                      [--mode setup|optional|required] [--label <word>] [--scim-auto-link on|off]
#   scripts/sso-env.sh [--dry-run] [--no-up] <box-label> --mode setup|optional|required|off
#   scripts/sso-env.sh [--dry-run] [--no-up] <box-label> --scim off|on
#   scripts/sso-env.sh ... --ssh <alias> [--stack <dir>]   (in place of <box-label>)
#
# <box-label> is looked up in .mantle-fleet.json, as scripts/roll.sh does.
# Only the lines asked for are touched; options combine.
# --tenant and --client set the issuer and the client id, the label, and the
# mode (setup unless --mode says otherwise). --mode alone changes only the
# mode (setup to optional once the admin has passed the Test, say).
# --label is the button word ("Sign in with <label>"), default Microsoft.
# --scim off stops SCIM (MANTLE_SCIM_TOKEN_HASH=off); company sign-in keeps
# working. --scim on removes that off line, so a token made on the setup
# screen works again; a real hash in .env is left as it is.
# --scim-auto-link is left as it is unless given.
# --dry-run prints, per line, "same" or "changes" (never a value) and stops.
# --no-up writes the lines and skips `docker compose up -d`.
#
# What it does on the box, in order:
#   1. prints, per line, same or changes, and whether .env holds a client secret
#      (yes or no only);
#   2. copies .env to backups/env/.env-<UTC time>-sso (owner and mode kept);
#   3. writes only the lines that change, keeping .env's owner and mode
#      (the updater's own env_rewrite and persist_env, sent from this checkout);
#   4. runs `docker compose up -d` in the stack (web, api and the workers are
#      recreated; running turns are cut), waits for web to be healthy, and
#      checks that web runs with the mode, issuer and client id it wrote.
# A failed step stops the script. To undo: copy the backup over .env and run
# `docker compose up -d` in the stack.
#
# Test hook: SSO_ENV_LOCAL=1 runs the box side with a local `sh` (needs
# --stack and --no-up). scripts/test-deploy-scripts.sh uses it.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
die() { echo "✗ $*" >&2; exit 1; }
usage() { sed -n '/^#   scripts\/sso-env.sh/p' "$0" | sed 's/^#   //' >&2; exit 2; }

DRY=0; UP=1; LABEL=""; SSH_ALIAS=""; STACK=""
TENANT=""; CLIENT=""; MODE=""; WORD=""; AUTOLINK=""; SCIM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --no-up) UP=0; shift ;;
    --tenant) TENANT=${2:-}; shift 2 ;;
    --client) CLIENT=${2:-}; shift 2 ;;
    --mode) MODE=${2:-}; shift 2 ;;
    --label) WORD=${2:-}; shift 2 ;;
    --scim-auto-link) AUTOLINK=${2:-}; shift 2 ;;
    --scim) SCIM=${2:-}; shift 2 ;;
    --ssh) SSH_ALIAS=${2:-}; shift 2 ;;
    --stack) STACK=${2:-}; shift 2 ;;
    -h | --help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) [ -z "$LABEL" ] || usage; LABEL=$1; shift ;;
  esac
done

# ── the values: every one reaches a remote shell and a sed, so whitelist ─────
guid() { printf '%s' "$1" | grep -Eqi '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; }
ISSUER=""
if [ -n "$TENANT$CLIENT" ]; then
  guid "$TENANT" || die "--tenant must be the Directory (tenant) ID, a GUID"
  guid "$CLIENT" || die "--client must be the Application (client) ID, a GUID"
  [ "$MODE" != off ] || die "--mode off takes no --tenant or --client"
  MODE=${MODE:-setup}; WORD=${WORD:-Microsoft}
  ISSUER="https://login.microsoftonline.com/$(printf '%s' "$TENANT" | tr 'A-F' 'a-f')/v2.0"
  CLIENT=$(printf '%s' "$CLIENT" | tr 'A-F' 'a-f')
fi
case "$MODE" in '' | setup | optional | required | off) ;; *) die "--mode is setup, optional, required or off" ;; esac
if [ -n "$WORD" ]; then
  case "$WORD" in *[!A-Za-z0-9\ ._-]*) die "--label: letters, digits, spaces, . _ - only" ;; esac
  [ ${#WORD} -le 60 ] || die "--label: at most 60 characters"
fi
case "$AUTOLINK" in '' | on | off) ;; *) die "--scim-auto-link is on or off" ;; esac
case "$SCIM" in '' | on | off) ;; *) die "--scim is on or off" ;; esac
[ -n "$MODE$WORD$AUTOLINK$SCIM" ] || usage

# ── the box ──────────────────────────────────────────────────────────────────
if [ "${SSO_ENV_LOCAL:-}" = 1 ]; then
  [ -n "$STACK" ] && [ "$UP" = 0 ] || die "SSO_ENV_LOCAL needs --stack and --no-up"
  rsh() { sh -c "$1"; }
else
  if [ -n "$LABEL" ]; then
    FLEET=${MANTLE_FLEET_FILE:-$ROOT/.mantle-fleet.json}
    [ -f "$FLEET" ] || die "no $FLEET: pass --ssh <alias> or add the box there (see .mantle-fleet.example.json)"
    command -v node >/dev/null || die "node is needed to read $FLEET"
    # shellcheck disable=SC2016  # JavaScript, not shell: nothing to expand
    BOX=$(node -e '
      const [file, label] = process.argv.slice(1);
      const raw = JSON.parse(require("fs").readFileSync(file, "utf8"));
      const boxes = Array.isArray(raw) ? raw : raw.boxes ?? [];
      const b = boxes.find((x) => x && x.label === label);
      if (!b) { console.error(`no box labelled "${label}" in ${file}`); process.exit(1); }
      console.log([b.ssh ?? "", b.stack ?? ""].join("\x1f"));
    ' "$FLEET" "$LABEL") || die "box lookup failed"
    IFS=$'\x1f' read -r cfg_ssh cfg_stack <<< "$BOX" || true
    SSH_ALIAS=${SSH_ALIAS:-$cfg_ssh}; STACK=${STACK:-$cfg_stack}
  fi
  [ -n "$SSH_ALIAS" ] || usage
  rsh() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_ALIAS" "$@"; }
  if [ -z "$STACK" ]; then
    # The updater's own stack dir: the only authoritative answer.
    STACK=$(rsh "docker inspect mantle_updater --format '{{range .Config.Env}}{{println .}}{{end}}'" \
      | sed -n 's/^MANTLE_STACK_DIR=//p' | head -1) || true
    [ -n "$STACK" ] || die "no stack dir from the box's updater; pass --stack"
  fi
fi
case "$STACK" in /*) ;; *) die "not an absolute path: $STACK" ;; esac
case "$STACK" in *[!A-Za-z0-9._/-]*) die "unexpected characters in path: $STACK" ;; esac

# The updater's .env writers, from this checkout, so the two never differ.
FUNCS=$(sed -n -e '/^file_owner() /p' -e '/^file_mode() /p' \
  -e '/^env_rewrite() {/,/^}/p' -e '/^persist_env() {/,/^}/p' "$ROOT/infra/updater/updater.sh")
[ -n "$FUNCS" ] || die "cannot read the .env writers from infra/updater/updater.sh"

# ── 1 to 3: compare, back up, write ─────────────────────────────────────────
BODY=$(cat <<'EOF'
set -e
[ -f "$STACK/.env" ] || { echo "✗ no .env in the stack"; exit 3; }
cur() { sed -n "s/^$1=//p" "$STACK/.env" | tail -1 | tr -d '\r'; }
NL='
'
WANT=""
[ -z "$MODE" ] || WANT="${WANT}MANTLE_OIDC_MODE=$MODE$NL"
[ -z "$ISSUER" ] || WANT="${WANT}MANTLE_OIDC_ISSUER=$ISSUER${NL}MANTLE_OIDC_CLIENT_ID=$CLIENT$NL"
[ -z "$WORD" ] || WANT="${WANT}MANTLE_OIDC_LABEL=$WORD$NL"
[ -z "$AUTOLINK" ] || WANT="${WANT}MANTLE_SCIM_AUTO_LINK=$AUTOLINK$NL"
[ "$SCIM" != off ] || WANT="${WANT}MANTLE_SCIM_TOKEN_HASH=off$NL"
CHANGE=""; DROP_SCIM_OFF=0
OLDIFS=$IFS; IFS=$NL
for line in $WANT; do
  name=${line%%=*}; val=${line#*=}
  if [ "$(cur "$name")" = "$val" ]; then echo "$name: same"; else echo "$name: changes"; CHANGE="$CHANGE$line$NL"; fi
done
IFS=$OLDIFS
if [ "$SCIM" = on ]; then
  hash=$(cur MANTLE_SCIM_TOKEN_HASH)
  if [ "$hash" = off ]; then echo "MANTLE_SCIM_TOKEN_HASH: changes (the off line goes)"; DROP_SCIM_OFF=1
  elif [ -n "$hash" ]; then echo "MANTLE_SCIM_TOKEN_HASH: same (a hash in .env, kept)"
  else echo "MANTLE_SCIM_TOKEN_HASH: same (no line)"; fi
fi
if grep -q '^MANTLE_OIDC_CLIENT_SECRET=..*' "$STACK/.env"; then echo "client secret in .env: yes (it wins over the screen)"; else echo "client secret in .env: no"; fi
[ "$DRY" = 0 ] || { echo "dry run: nothing written"; exit 0; }
[ -n "$CHANGE" ] || [ "$DROP_SCIM_OFF" = 1 ] || { echo "nothing to change"; exit 0; }
( umask 077; mkdir -p "$STACK/backups/env" )
BAK="$STACK/backups/env/.env-$(date -u +%Y%m%d-%H%M%S)-sso"
[ ! -e "$BAK" ] || BAK="$BAK-$$"
cp -p "$STACK/.env" "$BAK"
echo "backup: $BAK"
IFS=$NL
for line in $CHANGE; do persist_env "${line%%=*}" "${line#*=}"; done
IFS=$OLDIFS
[ "$DROP_SCIM_OFF" = 0 ] || env_rewrite '/^MANTLE_SCIM_TOKEN_HASH=off$/d'
echo "written"
EOF
)
q() { printf "'%s'" "$1"; } # every value is whitelisted above: no quote inside
VARS="STACK=$(q "$STACK") MODE=$(q "$MODE") ISSUER=$(q "$ISSUER") CLIENT=$(q "$CLIENT") WORD=$(q "$WORD") AUTOLINK=$(q "$AUTOLINK") SCIM=$(q "$SCIM") DRY=$(q "$DRY")"
OUT=$(printf '%s\n%s\n%s\n' "$VARS" "$FUNCS" "$BODY" | rsh 'sh -s') || { echo "$OUT"; die "the box side failed: .env is as it was, or see the backup line above"; }
echo "$OUT"
case "$OUT" in *"dry run"* | *"nothing to change"*) exit 0 ;; esac
[ "$UP" = 1 ] || { echo "--no-up: run 'docker compose up -d' in $STACK to apply"; exit 0; }

# ── 4: recreate and check ────────────────────────────────────────────────────
echo "▶ docker compose up -d (web, api and the workers are recreated)"
rsh "cd $(q "$STACK") && out=\$(docker compose up -d 2>&1); rc=\$?; printf '%s\n' \"\$out\" | tail -n 3; exit \$rc" || die "docker compose up -d failed: restore the backup and run it again"
health=""
for _ in $(seq 1 36); do
  health=$(rsh "docker inspect -f '{{.State.Health.Status}}' mantle_web" 2>/dev/null || true)
  [ "$health" = healthy ] && break
  sleep 5
done
[ "$health" = healthy ] || die "web is not healthy after 3 minutes ($health): read 'docker logs mantle_web', or restore the backup"
seen() { rsh "docker exec mantle_web printenv $1" 2>/dev/null | tr -d '\r' || true; }
ok=1
if [ -n "$MODE" ]; then
  [ "$(seen MANTLE_OIDC_MODE)" = "$MODE" ] && echo "web runs with the mode: yes" || { echo "web runs with the mode: NO"; ok=0; }
fi
if [ "$SCIM" = off ]; then
  [ "$(seen MANTLE_SCIM_TOKEN_HASH)" = off ] && echo "web runs with SCIM off: yes" || { echo "web runs with SCIM off: NO"; ok=0; }
fi
if [ -n "$ISSUER" ]; then
  [ "$(seen MANTLE_OIDC_ISSUER)" = "$ISSUER" ] && echo "web runs with the issuer: yes" || { echo "web runs with the issuer: NO"; ok=0; }
  [ "$(seen MANTLE_OIDC_CLIENT_ID)" = "$CLIENT" ] && echo "web runs with the client id: yes" || { echo "web runs with the client id: NO"; ok=0; }
fi
[ "$ok" = 1 ] || die "web does not run with what .env holds: a box compose file must pass the MANTLE_OIDC_* lines (docs/oidc-sign-in.md)"
[ "$MODE" != setup ] || echo "next: the box admin opens Settings > Company sign-in, enters the client secret, presses Test"
echo "✔ done"
