#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Mantle sanity check — is the stack actually up and serving?
#
# Inspects every container in the `mantle` compose project (works for both the
# prod docker-compose.yml and the dev docker-compose.dev.yml), reports health,
# treats the known one-shots (migrate / createbuckets / ollama_pull) as OK when
# they've completed cleanly, then confirms the app answers over HTTP.
#
# Exit 0 = all good; 1 = something is down. Run standalone or via install.sh.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
PROJECT="${MANTLE_COMPOSE_PROJECT:-mantle}"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  B=$'\033[1m'; DIM=$'\033[2m'; RS=$'\033[0m'
  RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLU=$'\033[34m'; CYN=$'\033[36m'
else B=; DIM=; RS=; RED=; GRN=; YLW=; BLU=; CYN=; fi
hd()  { printf '\n%s━━ %s %s\n' "$B$CYN" "$*" "$RS"; }
ok()  { printf '  %s✓%s %s\n' "$GRN" "$RS" "$*"; }
bad() { printf '  %s✗%s %s\n' "$RED" "$RS" "$*"; }
warn(){ printf '  %s!%s %s\n' "$YLW" "$RS" "$*"; }
inf() { printf '  %s•%s %s\n' "$BLU" "$RS" "$*"; }

hd "Sanity check"
if ! docker info >/dev/null 2>&1; then bad "Docker daemon isn't running."; exit 1; fi

# One-shots that are HEALTHY when exited(0), not when "running".
is_oneshot() { case "$1" in *_migrate|*_createbuckets|*_ollama_pull) return 0 ;; *) return 1 ;; esac; }

mapfile -t NAMES < <(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}' | sort)
# Dev machines run the `mantle-dev` compose project (docker-compose.dev.yml);
# fall back to it when the default prod project is empty and nothing was pinned.
if [[ ${#NAMES[@]} -eq 0 && -z "${MANTLE_COMPOSE_PROJECT:-}" ]]; then
  PROJECT="mantle-dev"
  mapfile -t NAMES < <(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}' | sort)
fi
# The owner UI is a SEPARATE compose project (`mantle-client`,
# docker-compose.client.yml) since the v0.200 split. Fold its container in so
# a brain with a perfectly healthy backend and NO usable interface can't pass
# a sanity check — the exact shape of a broken fresh install.
mapfile -t CLIENT_NAMES < <(docker ps -a --filter "label=com.docker.compose.project=mantle-client" --format '{{.Names}}' | sort)
NAMES+=("${CLIENT_NAMES[@]}")
if [[ ${#NAMES[@]} -eq 0 ]]; then bad "No containers found for compose project 'mantle' (or 'mantle-dev'). Is the stack up?"; exit 1; fi

fail=0; up=0
# A published port Docker could not program. When a host port is already taken,
# Docker aborts the container's ENTIRE network setup — it can end up `running`
# and `healthy` (the healthcheck only probes 127.0.0.1 INSIDE the container)
# while attached to no network, unable to reach postgres, and unreachable by
# Caddy. Silent, and fatal. Emits the port keys that were requested but never
# bound; empty for every healthy container.
UNBOUND_TPL='{{range $p, $b := .HostConfig.PortBindings}}{{if $b}}{{$a := index $.NetworkSettings.Ports $p}}{{if not $a}}{{$p}} {{end}}{{end}}{{end}}'
NETS_TPL='{{range $n, $v := .NetworkSettings.Networks}}{{$n}} {{end}}'
for name in "${NAMES[@]}"; do
  read -r state health exitcode < <(docker inspect \
    --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.ExitCode}}' \
    "$name" 2>/dev/null)
  short="${name#mantle_dev_}"; short="${short#mantle_}"
  if is_oneshot "$name"; then
    if [[ "$state" == "exited" && "$exitcode" == "0" ]]; then ok "$short ${DIM}(completed)${RS}"; up=$((up+1))
    elif [[ "$state" == "running" ]]; then inf "$short ${DIM}(running…)${RS}"
    else bad "$short — one-shot exited $exitcode (state: $state)"; fail=$((fail+1)); fi
    continue
  fi
  case "$state" in
    running)
      # Networking first: a container whose network setup failed still reports
      # healthy, so an unchecked "healthy" here is not evidence of anything.
      nets="$(docker inspect --format "$NETS_TPL" "$name" 2>/dev/null)"
      unbound="$(docker inspect --format "$UNBOUND_TPL" "$name" 2>/dev/null)"
      if [[ -z "${nets// /}" ]]; then
        bad "$short — running but attached to NO network (cannot reach postgres; Caddy cannot reach it)"
        inf "   ${DIM}Docker aborts container networking when a published port can't bind — free the port, then: docker compose up -d --force-recreate $short${RS}"
        fail=$((fail+1)); continue
      elif [[ -n "${unbound// /}" ]]; then
        bad "$short — published port(s) never bound: ${unbound% }  ${DIM}(host port already in use)${RS}"
        fail=$((fail+1)); continue
      fi
      case "$health" in
        healthy|none) ok "$short ${DIM}(${health})${RS}"; up=$((up+1)) ;;
        starting)     warn "$short — still starting (health: starting)" ;;
        *)            bad "$short — running but UNHEALTHY"; fail=$((fail+1)) ;;
      esac ;;
    restarting) bad "$short — restarting (crash loop?)"; fail=$((fail+1)) ;;
    exited)     bad "$short — exited $exitcode"; fail=$((fail+1)) ;;
    *)          bad "$short — state: $state"; fail=$((fail+1)) ;;
  esac
done

# ── app reachability ─────────────────────────────────────────────────────────
# Two rules learned the hard way:
#
#   1. Probe the door we tell people to OPEN — the Caddy front door — not the
#      loopback debug port. The old check hit http://localhost:3000 first and
#      declared success from it, so an install whose front door served nothing
#      still printed "app serving" next to "Open http://<ip>".
#   2. A status code proves nothing about WHO answered. :3000 is precisely the
#      port a leftover stack or a stray `next dev` is most likely to be holding,
#      and Mantle's own root response is a 307 to /login — so a squatter is
#      indistinguishable by code alone. /api/auth/bootstrap-state is public,
#      Mantle-specific and touches the DB, so its body is real evidence.
hd "App endpoint"
STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)"
ENV_FILE="${MANTLE_ENV_FILE:-$STACK_DIR/.env}"
envval() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
SITE_ADDRESS="$(envval MANTLE_SITE_ADDRESS)"
DEBUG_PORT="$(envval MANTLE_WEB_DEBUG_PORT)"; DEBUG_PORT="${DEBUG_PORT:-3000}"

P_CODE=""; P_BODY=""
probe() { # $1 = base url, $2 = extra curl args (unquoted, may be empty)
  local out
  # shellcheck disable=SC2086
  out="$(curl -sk --max-time 6 -w $'\n%{http_code}' $2 "$1/api/auth/bootstrap-state" 2>/dev/null)" || out=$'\n000'
  P_CODE="${out##*$'\n'}"; P_BODY="${out%$'\n'*}"
}
is_mantle() { [[ "$P_BODY" == *'"firstRun"'* ]]; }

# Front door first. With a domain, resolve the real hostname to this box —
# Caddy routes on the hostname, so probing bare `localhost` would miss the
# vhost and 404 on a perfectly working install.
CANDIDATES=()
[[ -n "$SITE_ADDRESS" && "$SITE_ADDRESS" != :* ]] \
  && CANDIDATES+=("https://$SITE_ADDRESS|--resolve $SITE_ADDRESS:443:127.0.0.1")
CANDIDATES+=("https://localhost|" "http://localhost|")

reached=""
for cand in "${CANDIDATES[@]}"; do
  url="${cand%%|*}"; extra="${cand#*|}"
  probe "$url" "$extra"
  [[ "$P_CODE" == 000 ]] && continue
  if is_mantle; then
    ok "App responding at ${B}$url${RS} → HTTP $P_CODE ${DIM}(verified Mantle)${RS}"
    reached="$url"; break
  elif [[ "$P_CODE" == 502 || "$P_CODE" == 503 || "$P_CODE" == 504 ]]; then
    # The front door is up; the app behind it is not reachable. Distinct from a
    # 500, which means the app answered and failed inside.
    bad "$url answered HTTP $P_CODE — the front door is up but cannot reach the app container."
    inf "   ${DIM}Usually the web container is down or lost its network: docker logs --tail 50 mantle_web${RS}"
    fail=$((fail+1)); reached="$url"; break
  elif [[ "$P_CODE" -ge 500 ]]; then
    bad "$url answered HTTP $P_CODE — the app is up but its bootstrap check failed (database unreachable?)."
    inf "   ${DIM}Check: docker logs --tail 50 mantle_web${RS}"
    fail=$((fail+1)); reached="$url"; break
  else
    warn "$url answered HTTP $P_CODE, but it is not Mantle — something else holds this address."
  fi
done

# Only now the loopback debug port, and only to tell the two failures apart:
# "the app is dead" vs "the app is alive but nothing can reach it".
if [[ -z "$reached" ]]; then
  probe "http://127.0.0.1:$DEBUG_PORT" ""
  if is_mantle; then
    bad "The app answers on 127.0.0.1:$DEBUG_PORT but the front door (:443/:80) does not — it is unreachable from outside this box."
    inf "   ${DIM}Caddy is the front door: docker logs --tail 50 mantle_caddy${RS}"
  else
    bad "App didn't answer on the front door (:443/:80) or on 127.0.0.1:$DEBUG_PORT."
  fi
  fail=$((fail+1))
fi

# ── summary ──────────────────────────────────────────────────────────────────
hd "Result"
if [[ $fail -eq 0 ]]; then ok "${B}All good${RS} — $up service(s) healthy, app serving at ${B}$reached${RS}."; exit 0
else bad "${B}$fail problem(s)${RS} above — $up healthy. See details."; exit 1; fi
