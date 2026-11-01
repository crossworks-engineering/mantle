// Fill npm's cache so `npm install --offline <kit package>` works in a new
// project with no network (the Dockerfile's nodekit stage runs this in a
// directory where the kit's libraries were just installed from the lock).
//
// An install from a lockfile caches only the tarballs; resolving a package
// with no lockfile also needs its registry metadata. So every package of the
// lock that this platform installs gets `npm cache add` (metadata and
// tarball), and then each one's registry integrity must equal the lock's:
// the cache can only ever hand out the tarballs the lock pins.
//
// Usage: node npm-cache-kit.mjs <cache dir>   (in the installed directory)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const cache = process.argv[2];
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const libc = process.report?.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl';
const fits = (want, have) => !want || want.includes(have) || want.every((w) => w.startsWith('!') && w !== `!${have}`);

const pinned = new Map();
for (const [path, p] of Object.entries(lock.packages)) {
  if (!path || p.link || !p.version) continue;
  if (!fits(p.os, process.platform) || !fits(p.cpu, process.arch) || !fits(p.libc, libc)) continue;
  const name = p.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  pinned.set(`${name}@${p.version}`, p.integrity);
}

const npm = (args) => execFileSync('npm', [...args, '--cache', cache, '--no-audit', '--no-fund'], { encoding: 'utf8' });
const specs = [...pinned.keys()];
for (let i = 0; i < specs.length; i += 40) npm(['cache', 'add', ...specs.slice(i, i + 40)]);

const wrong = [];
for (const [spec, integrity] of pinned) {
  const got = npm(['view', '--offline', spec, 'dist.integrity']).trim();
  if (got !== integrity) wrong.push(`${spec}: registry ${got || '(none)'} != lock ${integrity}`);
}
if (wrong.length) {
  console.error(`npm cache: ${wrong.length} package(s) differ from the lock:\n  ${wrong.join('\n  ')}`);
  process.exit(1);
}
console.log(`npm cache: ${pinned.size} kit packages cached, every one matching the lock`);
