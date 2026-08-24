#!/usr/bin/env node
/**
 * Publish the contract packages to npm (jackdaw split P1 —
 * docs/plans/jackdaw-repo-split.md).
 *
 * The workspace keeps the @mantle/* names (Mantle is the engine scope, a
 * deliberate naming split — see the Jackdaw rebrand notes); the @mantle npm
 * scope belongs to a third party, so the PUBLISHED names live under
 * @crossworks/*. The rename happens here, at publish time, and the files are
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
const NPM_SCOPE = '@crossworks';
const PACKAGES = ['client-types', 'content-core', 'voice-client', 'share-ui', 'app-build'];

const version = (process.argv[2] ?? '').replace(/^v/, '');
const dryRun = process.argv.includes('--dry-run');
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: publish-contract.mjs <version|vX.Y.Z> [--dry-run]');
  process.exit(1);
}

// Tag-vs-tree guard (the v0.232.59 incident): a tag created on the wrong
// commit publishes a STALE tree under a new version, and npm versions are
// immutable, so the mistake is permanent (0.232.59 is forever a byte-for-byte
// duplicate of 0.232.58). bump-version.mjs keeps these files in lockstep with
// the release, so the checked-out tree must already carry the version the tag
// names; on mismatch, fail before anything is packed or published.
for (const f of ['package.json', 'server/web/package.json']) {
  const treeVersion = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')).version;
  if (treeVersion !== version) {
    console.error(
      `✗ tag/tree mismatch: ${f} is at ${treeVersion}, but the requested publish version is ${version}.`,
    );
    console.error('  The tag points at the wrong commit. Nothing was published.');
    console.error(
      '  Delete the mispointed tag, then re-tag the correct release commit (scripts/tag-release.sh).',
    );
    process.exit(1);
  }
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
    // Cross-package deps: keep the @mantle/* KEY (the shipped TS source
    // imports that name) but point it at the published package via an npm
    // alias — the exact shape the 0.230.43 release shipped with. Leaving
    // `workspace:*` breaks the publish: by the time share-ui packs, its
    // sibling manifests are already renamed to @crossworks/*, so pnpm finds
    // no workspace project named @mantle/client-types and errors with
    // CANNOT_RESOLVE_WORKSPACE_PROTOCOL (the v0.230.57 run).
    for (const deps of [j.dependencies, j.peerDependencies, j.optionalDependencies]) {
      if (!deps) continue;
      for (const [dep, spec] of Object.entries(deps)) {
        const name = dep.replace(/^@mantle\//, '');
        if (dep !== name && PACKAGES.includes(name) && String(spec).startsWith('workspace:')) {
          deps[dep] = `npm:${NPM_SCOPE}/${name}@${version}`;
        }
      }
    }
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
    console.log(`→ ${j.name}@${version}${dryRun ? ' (dry run)' : ''}`);
    try {
      const out = execSync(
        `pnpm publish --access public --no-git-checks${dryRun ? ' --dry-run' : ''}`,
        {
          cwd: path.join(ROOT, 'packages', pkg),
          stdio: ['inherit', 'pipe', 'pipe'],
          encoding: 'utf8',
        },
      );
      process.stdout.write(out);
    } catch (err) {
      // npm versions are immutable, so a partially-published release makes
      // every later run die on the first already-published package before it
      // reaches the missing ones (the v0.230.57 run stopped at share-ui and
      // could never be re-run). Treat "already published" as done, not fatal.
      const msg = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      if (/cannot publish over|previously published|EPUBLISHCONFLICT/i.test(msg)) {
        console.log(`↷ ${NPM_SCOPE}/${pkg}@${version} already on npm — skipping`);
        continue;
      }
      process.stderr.write(msg);
      throw err;
    }
  }
} catch (err) {
  failed = true;
  console.error(err.message ?? err);
} finally {
  for (const [p, original] of backups) fs.writeFileSync(p, original);
}
process.exit(failed ? 1 : 0);
