#!/usr/bin/env node
// Bump the Mantle app version. The root package.json `version` is the single
// source of truth; apps/web/package.json is kept in lockstep so the two never
// drift. next.config.ts reads the root value and inlines it into the build.
//
// Usage:
//   pnpm version:bump patch          # 0.1.0 -> 0.1.1
//   pnpm version:bump minor          # 0.1.0 -> 0.2.0
//   pnpm version:bump major          # 0.1.0 -> 1.0.0
//   pnpm version:bump 1.4.2          # set explicitly
//
// Then commit and tag:  git tag v<new>
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['package.json', 'apps/web/package.json'].map((p) => join(root, p));

const arg = process.argv[2];
if (!arg) {
  console.error('usage: pnpm version:bump <patch|minor|major|x.y.z>');
  process.exit(1);
}

const current = JSON.parse(readFileSync(targets[0], 'utf8')).version;

function bump(v, kind) {
  const [maj, min, pat] = v.split('.').map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error(`unknown bump type "${kind}" — use patch | minor | major | x.y.z`);
}

const next = /^\d+\.\d+\.\d+$/.test(arg) ? arg : bump(current, arg);

for (const file of targets) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = next;
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

console.log(`✔ ${current} → ${next}  (updated ${targets.length} package.json files)`);
console.log(`  Next:  git commit -am "release: v${next}" && git tag v${next}`);
