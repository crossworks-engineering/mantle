#!/usr/bin/env bash
# Preflight for the demo seed/test stack: verify everything it needs is FREE.
#
# HARD RULE: this script only LOOKS. It never stops, kills, or restarts
# anything — a real Mantle stack is expected to be running on this host, and
# staying out of its way is the demo stack's core design constraint. If a
# check fails, we print what is in the way and exit non-zero; what to do
# about it is the operator's call.
set -euo pipefail

PORTS=(56432 56900 56901 56998 56434)
NAME_PREFIX="mantle_demo_"

fail=0

command -v docker >/dev/null || { echo "✗ docker not found on PATH" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "✗ docker daemon not reachable" >&2; exit 1; }

# ── Ports ────────────────────────────────────────────────────────────────────
# bash /dev/tcp probe: portable across macOS/Linux, no lsof/ss/nc dependency.
# A successful connect means something is listening — i.e. the port is taken.
for p in "${PORTS[@]}"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    exec 3>&- 3<&- || true
    echo "✗ port 127.0.0.1:$p is already in use" >&2
    fail=1
  fi
done

# ── Container names (global per Docker host — the axis that collides) ──────
existing=$(docker ps -a --format '{{.Names}}' | grep "^${NAME_PREFIX}" || true)
if [[ -n "$existing" ]]; then
  echo "✗ leftover ${NAME_PREFIX}* containers exist:" >&2
  echo "$existing" | sed 's/^/    /' >&2
  echo "  (a previous demo stack — 'scripts/stack-down.sh' removes it; add --wipe for volumes too)" >&2
  fail=1
fi

if [[ $fail -ne 0 ]]; then
  echo >&2
  echo "Preflight FAILED. Nothing was touched — resolve the above and re-run." >&2
  exit 1
fi

echo "✓ preflight clean: ports ${PORTS[*]} free, no ${NAME_PREFIX}* containers"
