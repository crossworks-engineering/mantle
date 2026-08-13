#!/usr/bin/env node
// Bump the Mantle app version. The root package.json `version` is the single
// source of truth; server/web + client/web package.json are kept in lockstep so they never
// drift. next.config.ts reads the root value and inlines it into the build.
//
// Usage:
//   pnpm version:bump patch          # 0.19.0-alpha -> 0.19.1
//   pnpm version:bump minor          # 0.19.0-alpha -> 0.20.0
//   pnpm version:bump major          # 0.19.0-alpha -> 1.0.0
//   pnpm version:bump 0.19.3-alpha   # set explicitly (pre-release tag allowed)
//
// While pre-1.0 we carry a `-alpha` pre-release tag (single-user, schema still
// churning). patch/minor/major bumps operate on the numeric core and DROP the
// tag — pass it back explicitly (e.g. `0.20.0-alpha`) to keep it. See
// docs/versioning.md.
//
// Then commit and tag:  git tag v<new>
//
// GUARD: refuses to run on any branch other than main (--force overrides).
// Bumping on a feature branch was the old ritual, and it made every concurrent
// worktree edit the same 4 version lines — guaranteed conflicts whenever two
// sessions were in flight. The bump now happens ON MAIN as part of the merge
// (scripts/merge-branch.sh), where merges are serialized by construction.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// client/desktop rides too: its version is what the packaged app reports
// (app.getVersion) and what electron-updater compares against releases — a
// drift there would stall or loop desktop auto-updates.
const targets = ['package.json', 'server/web/package.json'].map((p) => join(root, p));

const args = process.argv.slice(2);
const force = args.includes('--force');
const arg = args.find((a) => !a.startsWith('--'));
if (!arg) {
  console.error('usage: pnpm version:bump <patch|minor|major|x.y.z> [--force]');
  process.exit(1);
}

// Main-only guard (see header). A detached HEAD (CI checkout) and a missing
// git are both allowed through — the guard targets exactly one mistake:
// bumping on a feature branch in a worktree.
let branch = null;
try {
  branch = execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: root,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
} catch {
  /* no git / not a repo — nothing to guard */
}
if (!force && branch && branch !== 'main' && branch !== 'HEAD') {
  console.error(`✗ refusing to bump on branch "${branch}" — versions bump on main only.`);
  console.error('  Land the branch with scripts/merge-branch.sh (it bumps as part of the');
  console.error('  merge, where merges are serialized). Override with --force if you must.');
  process.exit(1);
}

const current = JSON.parse(readFileSync(targets[0], 'utf8')).version;

function bump(v, kind) {
  // Operate on the numeric core; any `-prerelease` tag is dropped (standard
  // semver behaviour — re-add it explicitly if you want to keep it).
  const [maj, min, pat] = v.replace(/-.*/, '').split('.').map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error(`unknown bump type "${kind}" — use patch | minor | major | x.y.z[-tag]`);
}

// Accept an explicit semver with an optional pre-release tag (e.g. 0.19.3-alpha).
const next = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(arg) ? arg : bump(current, arg);

for (const file of targets) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = next;
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

console.log(`✔ ${current} → ${next}  (updated ${targets.length} package.json files)`);

// The README's "By the numbers" block quotes the version alongside counted repo
// stats. Regenerating it here means every release commit carries fresh numbers
// instead of a block that silently ages. Cheap (git + fs, no network) and never
// fatal — a stats failure must not block a release.
try {
  execSync('node scripts/readme-stats.mjs', { cwd: root, stdio: 'inherit' });
} catch {
  console.warn('⚠ README stats not regenerated (run `pnpm readme:stats` by hand)');
}

console.log(`  Next:  git commit -am "release: v${next}" && git tag v${next}`);
