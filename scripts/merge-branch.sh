#!/usr/bin/env bash
set -euo pipefail
#
# merge-branch.sh — land a finished feature branch on main: ff-only merge, then
# the version bump AS PART OF THE MERGE, on main, in the integrator clone.
#
# Why: the old ritual (bump on the feature branch, then merge) made every
# concurrent session edit the same 4 package.json version lines, so two
# sessions in flight meant a guaranteed conflict (or worse, a silent dedupe)
# at whichever rebase happened second. Merges into main are already serialized
# through the integrator — only it has main checked out — so a bump done HERE,
# as its own `release:` commit right after the merge, cannot race another
# session's. Feature branches never touch version fields at all; see
# docs/versioning.md and the guard in bump-version.mjs.
#
# Usage:
#   scripts/merge-branch.sh <branch> [patch|minor|major]
#     branch  the finished feature branch (e.g. feat/remote-mcp)
#     bump    version part to bump on main after the merge (default: patch)
#
# Runs from anywhere in the repo (a worktree included) — it resolves the
# integrator clone from the shared git dir and operates there. No tag, no push:
# pushing a v* tag cuts a release, and pushes stay explicit.
#
branch="${1:-}"
kind="${2:-patch}"
if [ -z "$branch" ]; then
  echo "usage: scripts/merge-branch.sh <branch> [patch|minor|major]" >&2
  exit 1
fi
case "$kind" in
  patch|minor|major) ;;
  *) echo "✗ bump must be patch, minor or major (got \"$kind\")" >&2; exit 1 ;;
esac

# The integrator clone (NOT the current worktree) — same resolution as
# new-worktree.sh, so this works from inside a worktree too.
common="$(git rev-parse --git-common-dir)"
case "$common" in /*) ;; *) common="$(pwd)/$common" ;; esac
repo="$(cd "$(dirname "$common")" && pwd)"
cd "$repo"

if ! git show-ref --verify --quiet "refs/heads/$branch"; then
  echo "✗ branch $branch does not exist" >&2
  exit 1
fi
current="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current" != "main" ]; then
  echo "✗ the integrator clone is on \"$current\", not main — put it back first" >&2
  exit 1
fi
# Tracked changes block the merge; untracked files are fine (the integrator
# often carries local scratch).
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "✗ the integrator clone has uncommitted changes — commit or stash them first" >&2
  exit 1
fi

# Advisory lock: makes the serialization explicit if two sessions land at the
# exact same moment — the second one gets a clear message instead of a git
# index race. mkdir is atomic; a crashed run leaves the dir, so the message
# says how to clear it.
lock="$common/mantle-merge-branch.lock"
if ! mkdir "$lock" 2>/dev/null; then
  echo "✗ another merge-branch.sh appears to be running (lock: $lock)" >&2
  echo "  if you're sure it isn't, remove the dir: rmdir '$lock'" >&2
  exit 1
fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT

echo "→ git merge --ff-only $branch"
if ! git merge --ff-only "$branch"; then
  cat >&2 <<EOF
✗ not a fast-forward — main moved since $branch forked.
  Rebase in the branch's own worktree, then run this again:
    git rebase main      # from the worktree that has $branch checked out
    scripts/merge-branch.sh $branch $kind
EOF
  exit 1
fi

echo "→ version bump ($kind) on main"
node scripts/bump-version.mjs "$kind"
next="$(node -p "require('./package.json').version")"
# README.md rides along: bump-version.mjs regenerates its counted stats block.
git add package.json server/web/package.json client/web/package.json client/desktop/package.json README.md
git commit -m "release: v$next"

cat <<EOF

✓ $branch merged, main is at v$next
    scripts/rm-worktree.sh ${branch##*/}   # tear the worktree down when done
    git branch -d $branch                  # then delete the branch
    (push only when asked; pushing a v* TAG cuts a release)
EOF
