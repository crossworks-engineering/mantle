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
# Twin: the jackdaw repo carries the same script (scripts/tag-release.sh, with
# its harness scripts/test-tag-release.sh). A change to the push, the origin
# check or the resume rules here must be made there too, in the same pass.
# The copies differ only where the repos do: the version files, the workflows
# a tag fires, mantle's demo/ guard, and jackdaw having no --no-verify.
#
# Asserts, in the integrator clone (works from a worktree too):
#   1. main is checked out and has no uncommitted tracked changes
#   2. package.json and server/web/package.json agree on the version
#   3. HEAD is that version's release commit (subject "release: vX.Y.Z")
#   4. HEAD's tree has no demo/ (scripts/lib/demo-guard.sh, the check the
#      pre-push hook runs; the push below skips that hook)
#   5. the tag vX.Y.Z does not already exist (checked again just before the
#      tag is made: another session may tag it while verify runs)
# then runs `pnpm verify` on that tree, creates the tag at that commit only
# if it passed, pushes that commit as main + the tag together in one atomic
# push (the push is what cuts the release: it fires release.yml and
# publish-contract.yml), and finally asks origin, with git ls-remote, whether
# main and the tag are both there at that commit.
#
# "That commit" is HEAD as read ONCE, before the checks, and every step after
# names it by SHA, never by HEAD or by the branch name. The verify runs for
# minutes in the integrator clone, and another session can land a commit on
# main (scripts/merge-branch.sh) while it runs. Tagging HEAD and pushing
# `main` by name would then release that unverified, unguarded commit. So the
# tag is made at the captured SHA, the push sends `<sha>:refs/heads/main`, and
# when HEAD has moved by the time the verify ends the script refuses: NOT
# tagged, NOT pushed.
#
# After the push it exits non-zero, saying which ref is missing, when origin
# does not have main and the tag both at that commit; when origin cannot be
# asked at all it says the state is unknown, with ls-remote's own error; and
# when origin refused the atomic push because it already holds other work
# (its main has moved on, or it has a different tag of this name) it says to
# delete the local tag. Origin's tag is compared with the local tag's own
# object id, so a hand-made annotated tag (whose id is not the commit's) is
# judged right too.
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
# A resume trusts ANY tag already at HEAD. It cannot tell a tag this script
# made after a passing verify from one made by hand (`git tag vX.Y.Z`, no
# verify at all), and pushes either without verifying. If you did not make
# the tag with this script, delete it (git tag -d vX.Y.Z) and rerun.
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

# The shared demo/ guard, beside this script (resolved before the cd below).
# shellcheck source=lib/demo-guard.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/demo-guard.sh"

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

# The commit this run releases, read once. Every check, the tag and the push
# below name it by SHA (see the header): HEAD can move while verify runs.
head="$(git rev-parse HEAD)"

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
  behind="$(git rev-list --count "$head..@{u}")"
  if [ "$behind" != "0" ]; then
    echo "✗ main is $behind commit(s) BEHIND $(git rev-parse --abbrev-ref '@{u}')" >&2
    echo "  Someone released from another clone. Tagging now would publish a tree" >&2
    echo "  missing their work, and the push of main would be rejected anyway." >&2
    echo "  Integrate first, re-bump, then tag:" >&2
    echo "    git log --oneline main..@{u}    # what you are missing" >&2
    exit 1
  fi
fi

# Read from the captured commit, not the working tree, so the versions and
# the subject below describe the same commit the tag lands on.
read_version() {
  git show "$head:$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'
}
version="$(read_version package.json)"
web_version="$(read_version server/web/package.json)"
if [ "$version" != "$web_version" ]; then
  echo "✗ version drift: package.json is at $version but server/web/package.json is at $web_version" >&2
  echo "  bump-version.mjs keeps these in lockstep — fix the drift before tagging" >&2
  exit 1
fi

subject="$(git log -1 --pretty=%s "$head")"
if [ "$subject" != "release: v$version" ]; then
  echo "✗ HEAD is not the release commit for v$version" >&2
  echo "  HEAD:     $subject" >&2
  echo "  expected: release: v$version" >&2
  echo "  Land the branch first (scripts/merge-branch.sh <branch>) so main's tip" >&2
  echo "  IS the release commit, then run this again. Tagging any other commit" >&2
  echo "  is exactly the v0.232.59 mistake." >&2
  exit 1
fi

# demo/ must never reach main. The pre-push hook checks every push of main,
# but the release push below skips the hook, so the same check runs here,
# before the verify, so it fails in a second.
demo_guard "$head" tag-release || exit 1

tag="v$version"
short="$(git rev-parse --short "$head")"
resume=false
tag_exists_refusal() { # the refusal for a tag this run cannot resume
  echo "✗ tag $tag already exists (at $(git rev-parse --short "$tag"))" >&2
  echo "  If it points at the wrong commit, delete it first:" >&2
  echo "    git tag -d $tag        # and, if already pushed: git push origin :refs/tags/$tag" >&2
  echo "  (a pushed tag has already fired the release workflows: check Actions)" >&2
}
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  if [ "$(git rev-parse "refs/tags/$tag^{commit}")" = "$head" ]; then
    resume=true
    echo "→ tag $tag already exists at HEAD: an earlier run made it and its push did not land; resuming"
  else
    tag_exists_refusal
    exit 1
  fi
fi

if ! $resume; then
  if $verify; then
    echo "→ pnpm verify on $short, before the tag exists"
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
  # HEAD must still be the commit the checks and the verify judged. If
  # another session landed a commit on main meanwhile, that commit carries no
  # verify and no demo/ guard; nothing here may tag or push it, or this one
  # over it.
  now="$(git rev-parse HEAD)"
  if [ "$now" != "$head" ]; then
    echo >&2
    echo "✗ HEAD moved during the verify: it was $short, it is now $(git rev-parse --short "$now")" >&2
    echo "  Another session landed on main while this ran. NOT tagged, NOT pushed." >&2
    echo "  Look at what landed (git log --oneline $short..main), cut the release" >&2
    echo "  commit again with scripts/merge-branch.sh if it needs one, and rerun." >&2
    exit 1
  fi
  # The tag may have been made while the verify ran (another session, or a
  # tag by hand). Say so and what to do, not git tag's bare "already exists".
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    echo >&2
    tag_exists_refusal
    echo "  It was made while the verify ran: NOT tagged, NOT pushed by this run." >&2
    echo "  If another scripts/tag-release.sh run made it at $short, rerun this to" >&2
    echo "  resume its push; otherwise delete it as above and rerun." >&2
    exit 1
  fi
  git tag "$tag" "$head"
  echo "✓ tagged $short as $tag ($subject)"
fi
# What origin should report for the tag: the tag ref's own object. For the
# lightweight tag this script makes that is HEAD; for an annotated tag made by
# hand it is the tag object, which ls-remote reports, not the commit.
tag_obj="$(git rev-parse "refs/tags/$tag")"

# The SHA, not `main`: the branch may have moved since $head was read.
push_cmd="git push --atomic --no-verify origin $head:refs/heads/main refs/tags/$tag"
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

# Ask origin, not git push's exit code. Retried briefly, then judged. A failed
# ls-remote is not an answer: its stderr is kept, and the state is unknown.
remote_main=""
remote_tag=""
ls_rc=0
ls_out=""
for attempt in 1 2 3; do
  ls_rc=0
  ls_out="$(git ls-remote origin refs/heads/main "refs/tags/$tag" 2>&1)" || ls_rc=$?
  if [ "$ls_rc" = 0 ]; then
    remote_main="$(printf '%s\n' "$ls_out" | awk '$2 == "refs/heads/main" { print $1 }')"
    remote_tag="$(printf '%s\n' "$ls_out" | awk -v r="refs/tags/$tag" '$2 == r { print $1 }')"
    [ "$remote_main" = "$head" ] && [ "$remote_tag" = "$tag_obj" ] && break
  fi
  [ "$attempt" = 3 ] || sleep "${TAG_RELEASE_RECHECK_SECONDS:-2}"
done

if [ "$ls_rc" != 0 ]; then
  echo >&2
  echo "✗ NOT CONFIRMED: could not ask origin whether main and $tag landed; state unknown" >&2
  echo "  git push exited $push_rc; git ls-remote exited $ls_rc, saying:" >&2
  printf '%s\n' "$ls_out" | sed 's/^/    /' >&2
  echo "  The tag exists locally at $short. When origin answers again, rerun" >&2
  echo "  scripts/tag-release.sh: it resumes, and confirms a push that already landed." >&2
  echo "  Or check by hand:" >&2
  echo "    git ls-remote origin refs/heads/main refs/tags/$tag" >&2
  exit 1
fi

if [ "$remote_main" != "$head" ] || [ "$remote_tag" != "$tag_obj" ]; then
  echo >&2
  echo "✗ NOT RELEASED: origin does not have main and $tag at $short" >&2
  echo "  git push exited $push_rc" >&2
  echo "  origin main:     ${remote_main:-missing}" >&2
  echo "  origin $tag: ${remote_tag:-missing}" >&2
  echo "  expected main:   $head (HEAD)" >&2
  if [ "$tag_obj" = "$head" ]; then
    echo "  expected $tag: $head (HEAD)" >&2
  else
    echo "  expected $tag: $tag_obj (an annotated tag on HEAD)" >&2
  fi
  moved=false
  if [ -n "$remote_main" ] && [ "$remote_main" != "$head" ] &&
    ! git merge-base --is-ancestor "$remote_main" "$head" 2>/dev/null; then
    moved=true
  fi
  if [ -n "$remote_tag" ] && [ "$remote_tag" != "$tag_obj" ]; then
    moved=true
  fi
  if $moved; then
    echo "  Origin has moved on: its main holds commits this clone does not, or it" >&2
    echo "  already has a different $tag. The atomic push was refused and neither" >&2
    echo "  ref landed; a rerun would only push the local $tag again. Delete it:" >&2
    echo "    git tag -d $tag" >&2
    echo "  then bring main up to date (git fetch origin; git log --oneline main..origin/main" >&2
    echo "  shows what is missing), cut the release commit again with" >&2
    echo "  scripts/merge-branch.sh, and rerun scripts/tag-release.sh." >&2
  else
    echo "  The tag exists locally at HEAD. Rerun scripts/tag-release.sh to retry the" >&2
    echo "  push (it resumes), or by hand:" >&2
    echo "    $push_cmd" >&2
    echo "    git ls-remote origin refs/heads/main refs/tags/$tag" >&2
  fi
  exit 1
fi
if [ "$push_rc" != 0 ]; then
  echo "  (git push exited $push_rc, but origin has both refs at HEAD)"
fi
echo "✓ pushed main + $tag, origin confirms both at $short: release.yml and publish-contract.yml are running"
