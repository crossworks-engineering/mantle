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

if [ "${2:-}" = "-f" ]; then
  git worktree remove --force "$dir"
else
  git worktree remove "$dir"
fi
echo "✓ removed $dir (branch kept — delete with: git branch -d <branch> once merged)"
