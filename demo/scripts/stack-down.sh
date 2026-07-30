#!/usr/bin/env bash
# Tear down the demo seed/test stack.
#
#   scripts/stack-down.sh          stop + remove containers, KEEP volumes
#   scripts/stack-down.sh --wipe   also remove volumes → next up is a fresh
#                                  brain (what you want between generator runs)
#
# Scoped strictly to the mantle-demo compose project — cannot touch any other
# stack on the host.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--wipe" ]]; then
  docker compose --profile setup down -v --remove-orphans
  echo "✓ demo stack down, volumes wiped — next up starts from a fresh brain"
else
  docker compose --profile setup down --remove-orphans
  echo "✓ demo stack down (volumes kept — pass --wipe for a fresh brain)"
fi
