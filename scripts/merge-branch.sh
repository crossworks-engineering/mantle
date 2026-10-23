#!/usr/bin/env bash
# runs-on: mac. A dev or operator machine, the Mac included: keep it bash 3.2 and BSD-tool safe.
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

# Migration numbers are claimed here, at merge time, never ahead (lanes merge
# out of order). Print the next free number, and refuse a branch whose new
# migration has a number or a journal `when` at or below main's last: the
# runner treats a `when` it has seen as applied and skips it in silence, and
# two files with one number make the order a guess. The branch renumbers in
# its own worktree (file name, journal tag and idx, a `when` above main's)
# and keeps its renumber proof.
journal=packages/db/migrations/meta/_journal.json
mig_rc=0
if ! git cat-file -e "main:$journal" 2>/dev/null; then
  mig_rc=4
else
  mig_check="$(
  git show "main:$journal" | node -e '
    const fs = require("fs");
    const { execFileSync } = require("child_process");
    const [branch, journal] = process.argv.slice(1);
    const main = JSON.parse(fs.readFileSync(0, "utf8")).entries ?? [];
    let mine = [];
    try {
      mine = JSON.parse(
        execFileSync("git", ["show", `${branch}:${journal}`], { encoding: "utf8" }),
      ).entries ?? [];
    } catch {
      mine = [];
    }
    const num = (tag) => Number(/^(\d+)_/.exec(tag)?.[1] ?? NaN);
    const lastNum = Math.max(-1, ...main.map((e) => num(e.tag)).filter((n) => !isNaN(n)));
    const lastWhen = Math.max(0, ...main.map((e) => Number(e.when) || 0));
    const width = Math.max(4, ...main.map((e) => /^(\d+)_/.exec(e.tag)?.[1].length ?? 0));
    const next = String(lastNum + 1).padStart(width, "0");
    console.log(`next free migration number: ${next} (its journal when above ${lastWhen})`);
    const seen = new Set(main.map((e) => e.tag));
    const bad = [];
    for (const e of mine.filter((e) => !seen.has(e.tag))) {
      const n = num(e.tag);
      const w = Number(e.when) || 0;
      if (isNaN(n) || n <= lastNum) bad.push(`${e.tag}: number at or below main\x27s last (${String(lastNum).padStart(width, "0")})`);
      if (w <= lastWhen) bad.push(`${e.tag}: when ${w} at or below main\x27s last (${lastWhen})`);
    }
    // The own earlier stamps of the branch (its reflog: every head it had, so
    // the heads before a rebase too): a database that ran an earlier build
    // of the branch (a test or drill cluster) has a ledger row at each.
    // After a renumber every new entry must sit above them all, or the
    // runner reads a restamped entry as applied (the same when) or as a
    // gap below its mark.
    // The heads come from the branch reflog and, when that is empty (a
    // fresh clone, an expired reflog), from the copy of the branch on
    // origin (its reflog), and the commits that touched the journal on the
    // branch and on the origin copy past main (main..<branch>: the history
    // of main is not the branch). An earlier entry counts by its tag and stamp:
    // the same tag at the same stamp is the same migration.
    const mainWhens = new Set(main.map((e) => Number(e.when) || 0));
    const nowPairs = new Set(mine.map((e) => `${e.tag}@${Number(e.when) || 0}`));
    const lines = (args) => {
      try {
        return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
          .split("\n")
          .filter(Boolean);
      } catch {
        return [];
      }
    };
    const remote = `refs/remotes/origin/${branch}`;
    const heads = [
      ...lines(["log", "-g", "--format=%H", branch]),
      ...lines(["log", "-g", "--format=%H", remote]),
      ...lines(["log", "--format=%H", `main..${branch}`, "--", journal]),
      ...lines(["log", "--format=%H", `main..${remote}`, "--", journal]),
    ].slice(0, 1200);
    let stale = 0;
    const oldTags = new Map();
    for (const sha of new Set(heads)) {
      let old = [];
      try {
        old = JSON.parse(execFileSync("git", ["show", `${sha}:${journal}`], { encoding: "utf8" })).entries ?? [];
      } catch {
        continue;
      }
      for (const e of old) {
        const w = Number(e.when) || 0;
        if (mainWhens.has(w) || nowPairs.has(`${e.tag}@${w}`)) continue;
        if (w > stale) stale = w;
        if (!oldTags.has(w)) oldTags.set(w, new Set());
        oldTags.get(w).add(e.tag);
      }
    }
    const nowCount = new Map();
    for (const e of mine) nowCount.set(Number(e.when) || 0, (nowCount.get(Number(e.when) || 0) ?? 0) + 1);
    for (const e of mine.filter((e) => !seen.has(e.tag))) {
      const w = Number(e.when) || 0;
      if (stale > 0 && w <= stale) {
        bad.push(`${e.tag}: when ${w} at or below the branch\x27s own earlier stamps (${stale}): restamp the whole new set above them`);
      }
      if (oldTags.has(w)) {
        bad.push(`${e.tag}: when ${w} was ${[...oldTags.get(w)].join(", ")} in an earlier head of the branch`);
      }
      if ((nowCount.get(w) ?? 0) > 1 || mainWhens.has(w)) {
        bad.push(`${e.tag}: when ${w} is another migration\x27s too`);
      }
    }
    // A new migration file the journal does not name is a clash too.
    const files = (ref) =>
      execFileSync("git", ["ls-tree", "--name-only", `${ref}:packages/db/migrations`], { encoding: "utf8" })
        .split("\n")
        .filter((f) => /^\d+_.*\.sql$/.test(f));
    let branchFiles = [];
    try {
      branchFiles = files(branch);
    } catch {
      branchFiles = [];
    }
    const mainFiles = new Set(files("main"));
    for (const f of branchFiles.filter((f) => !mainFiles.has(f))) {
      if (num(f) <= lastNum && !bad.some((b) => b.startsWith(f.replace(/\.sql$/, "")))) {
        bad.push(`${f}: number at or below main\x27s last (${String(lastNum).padStart(width, "0")})`);
      }
    }
    for (const b of bad) console.log(`CLASH ${b}`);
    process.exit(bad.length ? 3 : 0);
  ' "$branch" "$journal"
  )" || mig_rc=$?
fi
case "$mig_rc" in
  0) printf '%s\n' "$mig_check" | sed -n 's/^next/→ next/p' ;;
  3)
    printf '%s\n' "$mig_check" | sed -n 's/^next/→ next/p'
    echo "✗ $branch adds a migration that clashes with main:" >&2
    printf '%s\n' "$mig_check" | sed -n 's/^CLASH /    /p' >&2
    cat >&2 <<EOF
  Renumber it in the branch's own worktree (the file name, the journal tag
  and idx, a \`when\` above main's last), keep the renumber proof test, then
  run this again. Nothing was merged.
EOF
    exit 1
    ;;
  4) echo "→ no migration journal on main: no migration check" ;;
  *)
    echo "✗ the migration check could not run (exit $mig_rc); nothing was merged" >&2
    exit 1
    ;;
esac

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
git add package.json server/web/package.json README.md
git commit -m "release: v$next"

cat <<EOF

✓ $branch merged, main is at v$next
    scripts/rm-worktree.sh ${branch##*/}   # tear the worktree down when done
    git branch -d $branch                  # then delete the branch
  To cut the release (pushing a v* tag is what triggers it):
    scripts/tag-release.sh                 # asserts HEAD == the v$next release
                                           # commit, then tags + pushes
  Never chain this script with a tag by hand — a failed merge with the tag
  still running is exactly how v0.232.59 shipped a stale tree to npm.
EOF
