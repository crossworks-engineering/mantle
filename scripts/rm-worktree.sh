#!/usr/bin/env bash
set -euo pipefail
#
# rm-worktree.sh — remove a worktree created by new-worktree.sh. Keeps the
# branch (delete that separately once it's merged). Refuses if the worktree has
# uncommitted changes unless you pass -f.
#
# Usage:
#   scripts/rm-worktree.sh <slug> [-f]
#
slug="${1:-}"
if [ -z "$slug" ]; then
  echo "usage: scripts/rm-worktree.sh <slug> [-f]" >&2
  exit 1
fi

# Resolve the original clone (worktrees live under it), not the current worktree.
common="$(git rev-parse --git-common-dir)"
case "$common" in /*) ;; *) common="$(pwd)/$common" ;; esac
repo="$(cd "$(dirname "$common")" && pwd)"
cd "$repo"
dir=".claude/worktrees/$slug"

# A throwaway brain on a shared Postgres (MANTLE_VIEWER_ROLES_PER_DATABASE=1)
# made cluster-wide login roles for its database: drop them while the
# worktree (and its node_modules) still exists. Skipped when git would refuse
# the removal below. Never drops the database itself.
env_file="$dir/server/web/.env.local"
if [ -f "$env_file" ] &&
  grep -Eqi '^[[:space:]]*MANTLE_VIEWER_ROLES_PER_DATABASE=["'\'']?(1|true|yes|on)["'\'']?[[:space:]]*$' "$env_file" &&
  { [ "${2:-}" = "-f" ] || [ -z "$(git -C "$dir" status --porcelain)" ]; }; then
  db_url="$(grep -E '^[[:space:]]*DATABASE_URL=' "$env_file" | tail -1 |
    sed -E "s/^[[:space:]]*DATABASE_URL=//; s/^[\"']//; s/[\"'][[:space:]]*$//")"
  db_name="${db_url##*/}"
  db_name="${db_name%%\?*}"
  echo "→ dropping the per-database viewer logins of \"$db_name\""
  if ! pnpm -C "$dir/packages/db" -s drop-viewer-logins "$db_name"; then
    echo "⚠ could not drop them. Later: pnpm -C packages/db drop-viewer-logins $db_name" >&2
    echo "  (or any migrate on that cluster drops them once the database is gone)" >&2
  fi
  echo "  The database \"$db_name\" is still on the cluster: drop it when you are done with it."
fi

if [ "${2:-}" = "-f" ]; then
  git worktree remove --force "$dir"
else
  git worktree remove "$dir"
fi
echo "✓ removed $dir (branch kept — delete with: git branch -d <branch> once merged)"
