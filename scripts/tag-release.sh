#!/usr/bin/env bash
# runs-on: mac. A dev or operator machine, the Mac included: keep it bash 3.2 and BSD-tool safe.
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
# then runs `pnpm verify` on that tree, creates the tag at HEAD only if it
# passed, pushes main + tag together in one atomic push (the push is what cuts
# the release: it fires release.yml and publish-contract.yml), and finally
# asks origin, with git ls-remote, whether main and the tag are both there at
# HEAD. It exits non-zero, saying which ref is missing, when they are not.
#
# Why the verify runs here and the push skips the pre-push hook: the hook ran
# the same `pnpm verify` on the same tree, but INSIDE `git push`, after git had
# opened the connection to GitHub and before it sent anything. After minutes
# of verify GitHub has closed that idle connection, and git dies of SIGPIPE
# (exit 141) on its first write, saying nothing but ssh's one line
# "Connection to github.com closed by remote host.". v0.300.50 and v0.300.58
# printed "pre-push: clean" and then nothing, leaving a local tag and no
# release (the push of this script's own branch did the same, 2026-10-15).
# When the hook failed instead (v0.300.56), the tag was already made and only
# main's push was refused. Running the gate
# first means a failure stops before any tag exists, and the push that follows
# is a few seconds long. The ls-remote check is the backstop for any push
# that reports success without landing, or fails without saying so.
#
# A rerun after a push that did not land resumes it: a tag that already
# exists AT HEAD is pushed again (no second verify, the tag was only made
# after one passed); a tag anywhere else is still refused.
#
# Usage:
#   scripts/tag-release.sh              # assert, verify, tag, push, check origin
#   scripts/tag-release.sh --no-push    # assert, verify, tag; print the push
#   scripts/tag-release.sh --no-verify  # skip `pnpm verify` (the gates already
#                                       # ran on this exact release commit)
#
push=true
verify=true
for arg in "$@"; do
  case "$arg" in
    --no-push) push=false ;;
    --no-verify) verify=false ;;
    *)
      echo "usage: scripts/tag-release.sh [--no-push] [--no-verify]" >&2
      exit 1
      ;;
  esac
done

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
head="$(git rev-parse HEAD)"
resume=false
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  if [ "$(git rev-parse "refs/tags/$tag^{commit}")" = "$head" ]; then
    resume=true
    echo "→ tag $tag already exists at HEAD: an earlier run made it and its push did not land; resuming"
  else
    echo "✗ tag $tag already exists (at $(git rev-parse --short "$tag"))" >&2
    echo "  If it points at the wrong commit, delete it first:" >&2
    echo "    git tag -d $tag        # and, if already pushed: git push origin :refs/tags/$tag" >&2
    echo "  (a pushed tag has already fired the release workflows — check Actions)" >&2
    exit 1
  fi
fi

if ! $resume; then
  if $verify; then
    echo "→ pnpm verify on $(git rev-parse --short HEAD), before the tag exists"
    if ! pnpm verify; then
      echo >&2
      echo "✗ pnpm verify failed on the release commit: NOT tagged, NOT pushed" >&2
      echo "  Fix it on a branch and land it, or, if the failure is the host and not the" >&2
      echo "  tree, rerun with --no-verify (CI still runs on the tag)." >&2
      exit 1
    fi
  else
    echo "→ --no-verify: skipping pnpm verify"
  fi
  git tag "$tag"
  echo "✓ tagged $(git rev-parse --short HEAD) as $tag ($subject)"
fi

push_cmd="git push --atomic --no-verify origin main refs/tags/$tag"
if ! $push; then
  echo "  push withheld (--no-push); when ready, rerun this script (it resumes), or:"
  echo "    $push_cmd"
  exit 0
fi

# --atomic: main and the tag land together or not at all, so a refused main
# can no longer leave a pushed tag firing the release workflows on its own.
# --no-verify: the verify above already ran on this tree (see the header).
push_rc=0
$push_cmd || push_rc=$?

# Ask origin, not git push's exit code. Retried briefly, then judged.
remote_main=""
remote_tag=""
for attempt in 1 2 3; do
  refs="$(git ls-remote origin refs/heads/main "refs/tags/$tag" 2>/dev/null)" || refs=""
  remote_main="$(printf '%s\n' "$refs" | awk '$2 == "refs/heads/main" { print $1 }')"
  remote_tag="$(printf '%s\n' "$refs" | awk -v r="refs/tags/$tag" '$2 == r { print $1 }')"
  [ "$remote_main" = "$head" ] && [ "$remote_tag" = "$head" ] && break
  [ "$attempt" = 3 ] || sleep "${TAG_RELEASE_RECHECK_SECONDS:-2}"
done

if [ "$remote_main" != "$head" ] || [ "$remote_tag" != "$head" ]; then
  echo >&2
  echo "✗ NOT RELEASED: origin does not have main and $tag at $(git rev-parse --short HEAD)" >&2
  echo "  git push exited $push_rc" >&2
  echo "  origin main:     ${remote_main:-missing}" >&2
  echo "  origin $tag: ${remote_tag:-missing}" >&2
  echo "  expected (HEAD): $head" >&2
  echo "  The tag exists locally at HEAD. Rerun scripts/tag-release.sh to retry the" >&2
  echo "  push (it resumes), or by hand:" >&2
  echo "    $push_cmd" >&2
  echo "    git ls-remote origin refs/heads/main refs/tags/$tag" >&2
  exit 1
fi
if [ "$push_rc" != 0 ]; then
  echo "  (git push exited $push_rc, but origin has both refs at HEAD)"
fi
echo "✓ pushed main + $tag, origin confirms both at $(git rev-parse --short HEAD): release.yml and publish-contract.yml are running"
