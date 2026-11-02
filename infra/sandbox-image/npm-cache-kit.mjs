// Fill npm's cache so `npm install --offline --before=<kit date> <kit package>`
// works in a new project with no network, and prove it gives exactly the
// lock's packages. The Dockerfile's nodekit stage runs this in a directory
// where the kit's libraries were just installed from the lock.
//
// An install from a lockfile caches only the tarballs; resolving a package
// with no lockfile also needs its registry metadata. So every package of the
// lock that this platform installs gets `npm cache add` (metadata and
// tarball) and `npm view` (the full metadata, with publish times), and each
// one's registry integrity must equal the lock's. The kit date is one second
// after the newest locked version was published: with `--before` set to it,
// npm resolves every range to what the lock holds, whatever the registry has
// published since. Last, the whole kit and each library alone are installed
// that way, offline, in empty projects: every package installed must be one
// the lock pins, and nothing the lock pins may be missing.
//
// Usage: node npm-cache-kit.mjs <cache dir> <file to write the kit date to> <the kit's lock>
// (run where the libraries were installed: its package.json lists them, its
// lock is the kit's lock trimmed to them; the check is against the whole one)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [cache, dateFile, kitLock] = process.argv.slice(2);
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const kit = JSON.parse(readFileSync(kitLock, 'utf8'));
const libs = Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).dependencies);
const libc = process.report?.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl';
// npm-install-checks: a list of allowed values, or of "!value" exclusions.
const fits = (want, have) => {
  if (!want) return true;
  if (want.includes(`!${have}`)) return false;
  return want.includes(have) || want.includes('any') || want.every((w) => w.startsWith('!'));
};
const nameOf = (path, p) => p.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);

// name@version -> integrity, for the packages of a lock this platform installs
const pinsOf = (l) => {
  const out = new Map();
  for (const [path, p] of Object.entries(l.packages)) {
    if (!path || p.link || !p.version) continue;
    if (!fits(p.os, process.platform) || !fits(p.cpu, process.arch) || !fits(p.libc, libc)) continue;
    out.set(`${nameOf(path, p)}@${p.version}`, p.integrity);
  }
  return out;
};
const pinned = pinsOf(lock);
const kitPins = pinsOf(kit);

const npm = (args, cwd) =>
  execFileSync('npm', [...args, '--cache', cache, '--no-audit', '--no-fund'], { encoding: 'utf8', cwd });
const specs = [...pinned.keys()];
for (let i = 0; i < specs.length; i += 40) npm(['cache', 'add', ...specs.slice(i, i + 40)]);

const wrong = [];
let newest = 0;
for (const [spec, integrity] of pinned) {
  const version = spec.slice(spec.lastIndexOf('@') + 1);
  const view = JSON.parse(npm(['view', spec, 'dist.integrity', 'time', '--json']));
  if (view['dist.integrity'] !== integrity) {
    wrong.push(`${spec}: registry ${view['dist.integrity'] ?? '(none)'} != lock ${integrity}`);
  }
  const at = Date.parse(view.time?.[version] ?? '');
  if (!Number.isFinite(at)) wrong.push(`${spec}: no publish time`);
  else newest = Math.max(newest, at);
}
if (wrong.length) {
  console.error(`npm cache: ${wrong.length} package(s) differ from the lock:\n  ${wrong.join('\n  ')}`);
  process.exit(1);
}
const before = new Date(newest + 1000).toISOString();

// The proof: the whole kit, and each library alone, offline, as of the kit
// date, in an empty project. Every package installed must be one the kit's
// lock pins, and the whole-kit install must hold every package the libraries
// need on this platform (npm drops an optional one it cannot get, silently).
const offlineInstall = (names) => {
  const proj = mkdtempSync(join(tmpdir(), 'kit-offline-'));
  writeFileSync(join(proj, 'package.json'), '{"name":"kit-offline","private":true}\n');
  npm(['install', '--offline', `--before=${before}`, '--ignore-scripts', ...names], proj);
  const got = new Set();
  for (const [path, p] of Object.entries(JSON.parse(readFileSync(join(proj, 'package-lock.json'), 'utf8')).packages)) {
    if (!path || p.link) continue;
    const spec = `${nameOf(path, p)}@${p.version}`;
    got.add(spec);
    if (kitPins.get(spec) !== p.integrity) wrong.push(`${names.join(' ')}: ${spec} is not the lock's`);
  }
  return got;
};
for (const spec of pinned.keys()) {
  if (!kitPins.has(spec)) wrong.push(`${spec}: in the trimmed lock but not the kit's`);
}
const whole = offlineInstall(libs);
for (const spec of pinned.keys()) {
  if (!whole.has(spec)) wrong.push(`${spec}: pinned but not installed offline`);
}
for (const lib of libs) offlineInstall([lib]);
if (wrong.length) {
  console.error(`npm cache: an offline install drifts from the lock:\n  ${wrong.join('\n  ')}`);
  process.exit(1);
}
writeFileSync(dateFile, `${before}\n`);
console.log(`npm cache: ${pinned.size} kit packages, each matching the lock; offline installs (the kit, and each of its ${libs.length} libraries alone) as of ${before} give the lock's`);
