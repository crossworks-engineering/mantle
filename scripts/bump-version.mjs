#!/usr/bin/env node
// Bump the Mantle app version. The root package.json `version` is the single
// source of truth; server/web/package.json is kept in lockstep so the two never
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
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['package.json', 'server/web/package.json'].map((p) => join(root, p));

const arg = process.argv[2];
if (!arg) {
  console.error('usage: pnpm version:bump <patch|minor|major|x.y.z>');
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
console.log(`  Next:  git commit -am "release: v${next}" && git tag v${next}`);
