#!/usr/bin/env node
/**
 * Publish the contract packages to npm (jackdaw split P1 —
 * docs/plans/jackdaw-repo-split.md).
 *
 * The workspace keeps the @mantle/* names (Mantle is the engine scope, a
 * deliberate naming split — see the Jackdaw rebrand notes); the @mantle npm
 * scope belongs to a third party, so the PUBLISHED names live under
 * @jackdaw-run/*. The rename happens here, at publish time, and the files are
 * restored afterwards so a local run leaves the tree clean.
 *
 * These packages ship TypeScript source (their exports point at ./src/*.ts).
 * That is deliberate: the sole consumer is the jackdaw Next app, which
 * transpiles them exactly as pnpm workspace deps are transpiled today.
 *
 * Usage:
 *   node scripts/publish-contract.mjs <version> [--dry-run]
 *   (CI passes the tag: v0.231.0 → 0.231.0)
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM_SCOPE = '@jackdaw-run';
// Order matters only for readability — pnpm rewrites workspace:* deps to the
// stamped version on pack, so share-ui's deps resolve to this same release.
const PACKAGES = ['client-types', 'content-core', 'voice-client', 'share-ui'];

const version = (process.argv[2] ?? '').replace(/^v/, '');
const dryRun = process.argv.includes('--dry-run');
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: publish-contract.mjs <version|vX.Y.Z> [--dry-run]');
  process.exit(1);
}

const backups = new Map();
let failed = false;
try {
  for (const pkg of PACKAGES) {
    const p = path.join(ROOT, 'packages', pkg, 'package.json');
    const original = fs.readFileSync(p, 'utf8');
    backups.set(p, original);
    const j = JSON.parse(original);
    j.name = `${NPM_SCOPE}/${pkg}`;
    j.version = version;
    delete j.private;
    j.license = 'SEE LICENSE IN LICENSE.md';
    j.repository = { type: 'git', url: 'https://github.com/crossworks-engineering/mantle' };
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
    console.log(`→ ${j.name}@${version}${dryRun ? ' (dry run)' : ''}`);
    execSync(`pnpm publish --access public --no-git-checks${dryRun ? ' --dry-run' : ''}`, {
      cwd: path.join(ROOT, 'packages', pkg),
      stdio: 'inherit',
    });
  }
} catch (err) {
  failed = true;
  console.error(err.message ?? err);
} finally {
  for (const [p, original] of backups) fs.writeFileSync(p, original);
}
process.exit(failed ? 1 : 0);
