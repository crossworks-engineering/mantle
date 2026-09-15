#!/usr/bin/env bash
set -euo pipefail
#
# tag-release.sh — tag main's release commit and push it, with the guards that
# would have caught the v0.232.59 incident: a chained merge && tag where the
# merge failed but the tag+push still ran put the tag on the PREVIOUS release
# commit, and publish-contract shipped that stale tree to npm before anyone
# could cancel. npm versions are immutable, so 0.232.59 is permanently a
# duplicate of 0.232.58.
#
# The rule this script encodes: never chain a merge with a tag. Merge first
# (scripts/merge-branch.sh), then run THIS, which refuses to tag anything that
# is not exactly main's own release commit.
#
# Asserts, in the integrator clone (works from a worktree too):
#   1. main is checked out and has no uncommitted tracked changes
#   2. package.json and server/web/package.json agree on the version
#   3. HEAD is that version's release commit (subject "release: vX.Y.Z")
#   4. the tag vX.Y.Z does not already exist
# then creates the tag at HEAD and pushes main + tag together (the push is
# what cuts the release: it fires release.yml and publish-contract.yml).
#
# Usage:
#   scripts/tag-release.sh            # assert, tag, push main + tag
#   scripts/tag-release.sh --no-push  # assert + tag only, print the push
#
push=true
if [ "${1:-}" = "--no-push" ]; then push=false
elif [ -n "${1:-}" ]; then
  echo "usage: scripts/tag-release.sh [--no-push]" >&2
  exit 1
fi

# The integrator clone (NOT the current worktree) — same resolution as
# merge-branch.sh, so this works from inside a worktree too.
common="$(git rev-parse --git-common-dir)"
case "$common" in /*) ;; *) common="$(pwd)/$common" ;; esac
repo="$(cd "$(dirname "$common")" && pwd)"
cd "$repo"

current="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current" != "main" ]; then
  echo "✗ the integrator clone is on \"$current\", not main — releases tag main only" >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "✗ the integrator clone has uncommitted changes — commit or stash them first" >&2
  exit 1
fi

# Assert main is not BEHIND its remote. Everything below asserts facts about
# the LOCAL tree, all of which can be true of a stale clone — which is how
# jackdaw v0.6.109's pair shipped a mantle tag built on a tree that reverted a
# fix landed from another machine (2026-09-15). The tag pushed; main was
# rejected as non-fast-forward, which is the FIRST anyone hears of it, and by
# then the publish workflows are already running. Fetch and check instead.
#
# Skipped when there is no upstream (a fresh clone, or CI with no remote).
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  echo "→ fetching, so a stale clone cannot tag a stale tree"
  git fetch --quiet origin || { echo "✗ git fetch failed — refusing to tag blind" >&2; exit 1; }
  behind="$(git rev-list --count 'main..@{u}')"
  if [ "$behind" != "0" ]; then
    echo "✗ main is $behind commit(s) BEHIND $(git rev-parse --abbrev-ref '@{u}')" >&2
    echo "  Someone released from another clone. Tagging now would publish a tree" >&2
    echo "  missing their work, and the push of main would be rejected anyway." >&2
    echo "  Integrate first, re-bump, then tag:" >&2
    echo "    git log --oneline main..@{u}    # what you are missing" >&2
    exit 1
  fi
fi

version="$(node -p "require('./package.json').version")"
web_version="$(node -p "require('./server/web/package.json').version")"
if [ "$version" != "$web_version" ]; then
  echo "✗ version drift: package.json is at $version but server/web/package.json is at $web_version" >&2
  echo "  bump-version.mjs keeps these in lockstep — fix the drift before tagging" >&2
  exit 1
fi

subject="$(git log -1 --pretty=%s)"
if [ "$subject" != "release: v$version" ]; then
  echo "✗ HEAD is not the release commit for v$version" >&2
  echo "  HEAD:     $subject" >&2
  echo "  expected: release: v$version" >&2
  echo "  Land the branch first (scripts/merge-branch.sh <branch>) so main's tip" >&2
  echo "  IS the release commit, then run this again. Tagging any other commit" >&2
  echo "  is exactly the v0.232.59 mistake." >&2
  exit 1
fi

tag="v$version"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "✗ tag $tag already exists (at $(git rev-parse --short "$tag"))" >&2
  echo "  If it points at the wrong commit, delete it first:" >&2
  echo "    git tag -d $tag        # and, if already pushed: git push origin :refs/tags/$tag" >&2
  echo "  (a pushed tag has already fired the release workflows — check Actions)" >&2
  exit 1
fi

git tag "$tag"
echo "✓ tagged $(git rev-parse --short HEAD) as $tag ($subject)"

if $push; then
  git push origin main "$tag"
  echo "✓ pushed main + $tag — release.yml and publish-contract.yml are running"
else
  echo "  push withheld (--no-push); when ready:"
  echo "    git push origin main $tag"
fi
