#!/usr/bin/env node
/**
 * Publish the contract packages to npm (jackdaw split P1,
 * docs/plans/jackdaw-repo-split.md).
 *
 * The workspace keeps the @mantle/* names (Mantle is the engine scope, a
 * deliberate naming split, see the Jackdaw rebrand notes); the @mantle npm
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
 *   node scripts/publish-contract.mjs --check [version]
 *   (CI passes the tag: v0.231.0 -> 0.231.0. --check defaults to the tree's
 *   own version, so it runs on any checkout.)
 *
 * --check is the pre-publish smoke test: it stages every manifest exactly as
 * a publish would, packs each package with `pnpm pack` (the packer behind
 * `pnpm publish`, so the tarball is what would ship), and installs each
 * tarball into a fresh temp project with `npm install --ignore-scripts`
 * against the real registry. A dependency that does not exist on npm fails
 * HERE, before anything is uploaded, instead of in a consumer's install after
 * the version is immutable. Needs network; leaves the tree clean.
 * publish-contract.yml runs it right before the publish step.
 *
 * The pure pieces (stageManifest, findPrivateDeps, assertPublishable) are
 * exported for server/web/lib/publish-contract.test.ts; importing this file
 * runs nothing.
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The public npm scope every contract package is published under. */
export const NPM_SCOPE = '@crossworks';
/** The private workspace scope. Nothing under it exists on npm. */
export const WORKSPACE_SCOPE = '@mantle';
/**
 * The contract packages, in dependency order (share-ui needs client-types and
 * content-core; app-build needs share-ui). packages/<name> is the directory
 * and @mantle/<name> the workspace name.
 */
export const PACKAGES = ['client-types', 'content-core', 'voice-client', 'share-ui', 'app-build'];

const CONSUMER_SECTIONS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const ALL_SECTIONS = [...CONSUMER_SECTIONS, 'devDependencies'];
const PRIVATE_PREFIX = `${WORKSPACE_SCOPE}/`;

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unscoped = (dep) =>
  dep.startsWith(PRIVATE_PREFIX) ? dep.slice(PRIVATE_PREFIX.length) : null;

/**
 * Rewrite one workspace manifest into the shape that ships to npm. Pure:
 * returns a new object and never touches the disk.
 *
 * @param {Record<string, any>} manifest the workspace package.json, parsed
 * @param {{ pkg: string, version: string, scope?: string, packages?: string[] }} opts
 *   pkg is the packages/<pkg> directory name; version the release being cut
 * @returns {Record<string, any>}
 */
export function stageManifest(manifest, { pkg, version, scope = NPM_SCOPE, packages = PACKAGES }) {
  const j = structuredClone(manifest);
  j.name = `${scope}/${pkg}`;
  j.version = version;
  delete j.private;
  j.license = 'SEE LICENSE IN LICENSE.md';
  j.repository = { type: 'git', url: 'https://github.com/crossworks-engineering/mantle' };
  // Cross-package deps: keep the @mantle/* KEY (the shipped TS source imports
  // that name) but point it at the published package via an npm alias, the
  // exact shape the 0.230.43 release shipped with. Leaving `workspace:*`
  // breaks the publish: by the time share-ui packs, its sibling manifests are
  // already renamed to @crossworks/*, so pnpm finds no workspace project
  // named @mantle/client-types and errors with
  // CANNOT_RESOLVE_WORKSPACE_PROTOCOL (the v0.230.57 run).
  //
  // Only siblings in `packages` are aliased. Any OTHER @mantle/* dep is left
  // exactly as found, for assertPublishable to refuse: it must never be
  // rewritten into something that looks resolvable.
  for (const section of CONSUMER_SECTIONS) {
    const deps = j[section];
    if (!deps) continue;
    for (const [dep, spec] of Object.entries(deps)) {
      const name = unscoped(dep);
      if (name && packages.includes(name) && String(spec).startsWith('workspace:')) {
        deps[dep] = `npm:${scope}/${name}@${version}`;
      }
    }
  }
  return j;
}

/**
 * Every dependency entry that would send a consumer to a name that is not on
 * npm. Any @mantle/* key or spec that survives staging is a private workspace
 * name; the one allowed shape is a sibling contract package whose key stayed
 * @mantle/<name> and whose spec was aliased to npm:@crossworks/<name>@<v>,
 * the deliberate shape stageManifest documents. Checked across every
 * dependency section: a workspace: spec anywhere breaks `pnpm publish`, and a
 * private name in a consumer-facing section breaks every consumer's install.
 * Returns [] for a publishable manifest.
 *
 * @param {Record<string, any>} manifest a STAGED manifest (after stageManifest)
 * @param {{ scope?: string }} [opts]
 * @returns {{ section: string, dep: string, spec: string, reason: string }[]}
 */
export function findPrivateDeps(manifest, { scope = NPM_SCOPE } = {}) {
  const alias = new RegExp(`^npm:${escapeRegExp(scope)}/[^@/]+@`);
  const bad = [];
  for (const section of ALL_SECTIONS) {
    const deps = manifest[section];
    if (!deps) continue;
    for (const [dep, raw] of Object.entries(deps)) {
      const spec = String(raw);
      let reason = null;
      if (dep.startsWith(PRIVATE_PREFIX) && !alias.test(spec)) {
        reason =
          `${dep} is a private workspace name that does not exist on npm; only a sibling ` +
          `contract package aliased to npm:${scope}/<name>@<version> may keep a ${PRIVATE_PREFIX}* key`;
      } else if (spec.startsWith(PRIVATE_PREFIX) || spec.startsWith(`npm:${PRIVATE_PREFIX}`)) {
        reason = `the spec points at the private ${WORKSPACE_SCOPE} scope`;
      } else if (spec.startsWith('workspace:')) {
        reason = 'a workspace: spec cannot be resolved outside this monorepo';
      }
      if (reason) bad.push({ section, dep, spec, reason });
    }
  }
  return bad;
}

/**
 * Throw, naming the package and every offending dependency, if the staged
 * manifest would publish an uninstallable package. The v0.232.122-153
 * app-build tarballs shipped "@mantle/config": "0.0.1" and
 * "@mantle/std": "0.0.1" (pnpm publish had turned workspace:* into the
 * workspace version) and no consumer could install them; npm versions are
 * immutable, so those releases are unfixable. This is the gate that makes a
 * repeat impossible: it runs before anything is packed or uploaded.
 *
 * @param {Record<string, any>} manifest a STAGED manifest
 * @param {{ scope?: string }} [opts]
 */
export function assertPublishable(manifest, opts = {}) {
  const bad = findPrivateDeps(manifest, opts);
  if (bad.length === 0) return;
  const lines = bad.map((b) => `    ${b.section} "${b.dep}": "${b.spec}"\n      ${b.reason}`);
  throw new Error(
    `${manifest.name}@${manifest.version} is NOT publishable: ${bad.length} ` +
      `dependenc${bad.length === 1 ? 'y' : 'ies'} would not resolve on npm\n${lines.join('\n')}\n` +
      '  Drop the import, or move the code into a contract package. Nothing was published.',
  );
}

// ---------------------------------------------------------------------------
// CLI

const pkgDir = (pkg) => path.join(ROOT, 'packages', pkg);
const manifestPath = (pkg) => path.join(pkgDir(pkg), 'package.json');

function usage() {
  console.error('usage: publish-contract.mjs <version|vX.Y.Z> [--dry-run]');
  console.error('       publish-contract.mjs --check [version|vX.Y.Z]');
  process.exit(1);
}

/**
 * Stage every contract manifest in memory, gate ALL of them, and only then
 * rewrite them on disk. Failing before a single pack or publish is the whole
 * point: a partial publish is the expensive failure (immutable versions), a
 * restored tree is free. `backups` receives the originals for the caller to
 * restore; returns the staged manifests by package.
 */
function stageAll(version, backups) {
  const staged = new Map();
  const problems = [];
  for (const pkg of PACKAGES) {
    const original = fs.readFileSync(manifestPath(pkg), 'utf8');
    const j = stageManifest(JSON.parse(original), { pkg, version });
    try {
      assertPublishable(j);
    } catch (err) {
      problems.push(err.message);
    }
    staged.set(pkg, { original, j });
  }
  if (problems.length) throw new Error(problems.join('\n'));
  for (const pkg of PACKAGES) {
    const p = manifestPath(pkg);
    backups.set(p, staged.get(pkg).original);
    fs.writeFileSync(p, JSON.stringify(staged.get(pkg).j, null, 2) + '\n');
  }
  return new Map([...staged].map(([pkg, { j }]) => [pkg, j]));
}

function publishAll(staged, version, dryRun) {
  for (const pkg of PACKAGES) {
    console.log(`→ ${staged.get(pkg).name}@${version}${dryRun ? ' (dry run)' : ''}`);
    try {
      const out = execSync(
        `pnpm publish --access public --no-git-checks${dryRun ? ' --dry-run' : ''}`,
        { cwd: pkgDir(pkg), stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' },
      );
      process.stdout.write(out);
    } catch (err) {
      // npm versions are immutable, so a partially-published release makes
      // every later run die on the first already-published package before it
      // reaches the missing ones (the v0.230.57 run stopped at share-ui and
      // could never be re-run). Treat "already published" as done, not fatal.
      const msg = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      if (/cannot publish over|previously published|EPUBLISHCONFLICT/i.test(msg)) {
        console.log(`↷ ${NPM_SCOPE}/${pkg}@${version} already on npm, skipping`);
        continue;
      }
      process.stderr.write(msg);
      throw err;
    }
  }
}

/** Contract packages `pkg` reaches through its aliased @mantle/* keys, transitively. */
function siblingClosure(staged, pkg) {
  const seen = new Set();
  const walk = (name) => {
    for (const section of CONSUMER_SECTIONS) {
      for (const dep of Object.keys(staged.get(name)[section] ?? {})) {
        const sib = unscoped(dep);
        if (sib && PACKAGES.includes(sib) && !seen.has(sib)) {
          seen.add(sib);
          walk(sib);
        }
      }
    }
  };
  walk(pkg);
  seen.delete(pkg);
  return [...seen];
}

/**
 * Pack every staged package and install each tarball into a fresh project
 * against the real registry, so an unresolvable dependency fails here rather
 * than on a consumer. Sibling contract packages are published in this same
 * run, so their aliased versions are not on the registry yet: each install
 * pre-provides them from the local tarballs under the SAME @mantle/<name>
 * key the alias uses, and npm dedupes the alias edge against that node. The
 * tarball itself keeps the exact manifest that ships.
 */
function smokeInstall(staged, version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-contract-'));
  try {
    const tarballs = new Map();
    for (const pkg of PACKAGES) {
      const dest = path.join(tmp, 'tarballs', pkg);
      fs.mkdirSync(dest, { recursive: true });
      execFileSync('pnpm', ['pack', '--pack-destination', dest], {
        cwd: pkgDir(pkg),
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const tgz = fs.readdirSync(dest).filter((f) => f.endsWith('.tgz'));
      if (tgz.length !== 1) {
        throw new Error(`pnpm pack of ${pkg} left ${tgz.length} tarballs in ${dest}, expected one`);
      }
      tarballs.set(pkg, path.join(dest, tgz[0]));
      console.log(`packed ${tgz[0]}`);
    }
    for (const pkg of PACKAGES) {
      const dir = path.join(tmp, 'install', pkg);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'contract-smoke', private: true }) + '\n',
      );
      const siblings = siblingClosure(staged, pkg).map(
        (s) => `${WORKSPACE_SCOPE}/${s}@file:${tarballs.get(s)}`,
      );
      console.log(`→ npm install ${NPM_SCOPE}/${pkg}@${version} (fresh project, real registry)`);
      execFileSync(
        'npm',
        [
          'install',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--loglevel=error',
          ...siblings,
          tarballs.get(pkg),
        ],
        { cwd: dir, stdio: 'inherit' },
      );
      console.log(`✓ ${NPM_SCOPE}/${pkg}@${version} installs clean`);
    }
  } catch (err) {
    console.error(`  (temp dir kept for inspection: ${tmp})`);
    throw err;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

function main(argv) {
  const check = argv.includes('--check');
  const dryRun = argv.includes('--dry-run');
  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length > 1) usage();
  let version = (positional[0] ?? '').replace(/^v/, '');
  if (check && !version) version = readJson(path.join(ROOT, 'package.json')).version;
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) usage();

  // Tag-vs-tree guard (the v0.232.59 incident): a tag created on the wrong
  // commit publishes a STALE tree under a new version, and npm versions are
  // immutable, so the mistake is permanent (0.232.59 is forever a byte-for-byte
  // duplicate of 0.232.58). bump-version.mjs keeps these files in lockstep with
  // the release, so the checked-out tree must already carry the version the tag
  // names; on mismatch, fail before anything is packed or published.
  for (const f of ['package.json', 'server/web/package.json']) {
    const treeVersion = readJson(path.join(ROOT, f)).version;
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
    const staged = stageAll(version, backups);
    if (check) smokeInstall(staged, version);
    else publishAll(staged, version, dryRun);
  } catch (err) {
    failed = true;
    console.error(`✗ ${err.message ?? err}`);
  } finally {
    for (const [p, original] of backups) fs.writeFileSync(p, original);
  }
  if (check && !failed) {
    console.log(
      `✓ all ${PACKAGES.length} contract packages stage, pack and install; tree restored`,
    );
  }
  process.exit(failed ? 1 : 0);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv.slice(2));
