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
if [[ ${#NAMES[@]} -eq 0 ]]; then bad "No containers found for compose project 'mantle' (or 'mantle-dev'). Is the stack up?"; exit 1; fi

fail=0; up=0
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
hd "App endpoint"
reached=""
for url in "http://localhost:3000" "https://localhost" "http://localhost"; do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 6 "$url" 2>/dev/null || echo 000)
  if [[ "$code" != "000" && "$code" -ge 200 && "$code" -lt 500 ]]; then
    ok "App responding at ${B}$url${RS} → HTTP $code"; reached=1; break
  fi
done
if [[ -z "$reached" ]]; then bad "App didn't answer on :3000, :443, or :80 (a 5xx/no-response)."; fail=$((fail+1)); fi

# ── summary ──────────────────────────────────────────────────────────────────
hd "Result"
if [[ $fail -eq 0 ]]; then ok "${B}All good${RS} — $up service(s) healthy, app serving."; exit 0
else bad "${B}$fail problem(s)${RS} above — $up healthy. See details."; exit 1; fi
