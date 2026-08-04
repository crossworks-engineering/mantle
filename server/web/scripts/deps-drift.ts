/**
 * Dependency drift report — how far behind our declared ranges have drifted.
 *
 * WHY THIS EXISTS: a caret range is permission, not a mechanism. `@openrouter/sdk`
 * sat at 1.0.0 for 46 releases while its manifest said `^1.0.0` the whole time,
 * because nothing ever ran an update and nothing ever said so. Declaring a range
 * and never resolving it looks identical to being current.
 *
 * Read-only and free: it reads local package.json files and the public npm
 * registry. It never writes, never installs, and never touches the database.
 *
 *   pnpm -C server/web deps:drift            # in-range drift only (the actionable set)
 *   pnpm -C server/web deps:drift --majors   # also list out-of-range majors
 *   pnpm -C server/web deps:drift --json     # machine-readable
 *
 * Exit code is 0 even when drift is found — this reports, it does not gate. A
 * non-zero exit would make the nightly sweep look like a failure every time a
 * dependency published a patch.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const WORKSPACE_DIRS = ['packages', 'server', 'client', 'e2e'];
const CONCURRENCY = 8;

type Dep = { pkg: string; range: string; from: string };
type Drift = {
  pkg: string;
  range: string;
  from: string[];
  inRange: string | null;
  latest: string;
  major: boolean;
};

/** Parse "1.2.3" into comparable parts. Returns null for anything non-numeric
 *  (prereleases, tags) — those are deliberately ignored rather than guessed at. */
function parse(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function gt(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
}

/**
 * Does `version` satisfy `range`?
 *
 * Handles the three forms this repo actually uses — `^x.y.z`, `~x.y.z`, and a
 * bare pin. Anything else (unions, ranges, tags) returns false so the package
 * is reported as "unknown range" rather than silently mis-judged. Deliberately
 * NOT a general semver implementation: a wrong answer here is worse than no
 * answer, and the repo's conventions are narrow.
 */
function satisfies(version: string, range: string): boolean | null {
  const v = parse(version);
  if (!v) return false;
  const exact = parse(range);
  if (exact) return v[0] === exact[0] && v[1] === exact[1] && v[2] === exact[2];

  const m = /^([\^~])(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!m) return null; // unsupported range form — caller reports it as such
  const base: [number, number, number] = [Number(m[2]), Number(m[3]), Number(m[4])];
  if (!gt(v, base) && !(v[0] === base[0] && v[1] === base[1] && v[2] === base[2])) return false;
  // Caret allows minor+patch within the major; tilde allows patch within the minor.
  // (npm's caret treats 0.x specially — 0.x ranges pin the minor. Mirrored here.)
  if (m[1] === '^') {
    return base[0] === 0 ? v[0] === 0 && v[1] === base[1] : v[0] === base[0];
  }
  return v[0] === base[0] && v[1] === base[1];
}

/** Every package.json in the workspace, including the root. */
function manifests(): string[] {
  const out: string[] = [join(REPO_ROOT, 'package.json')];
  for (const dir of WORKSPACE_DIRS) {
    const base = join(REPO_ROOT, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = join(base, entry.name, 'package.json');
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

function collectDeps(): Dep[] {
  const deps: Dep[] = [];
  for (const file of manifests()) {
    const json = JSON.parse(readFileSync(file, 'utf8')) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const label = json.name ?? file.replace(`${REPO_ROOT}/`, '');
    for (const block of [json.dependencies, json.devDependencies]) {
      for (const [pkg, range] of Object.entries(block ?? {})) {
        // Internal packages and catalog aliases have no registry entry.
        if (range.startsWith('workspace:') || range.startsWith('catalog:')) continue;
        if (range.startsWith('link:') || range.startsWith('file:')) continue;
        deps.push({ pkg, range, from: label });
      }
    }
  }
  return deps;
}

/** Abbreviated registry metadata — far smaller than the full document. */
async function versionsOf(pkg: string): Promise<string[] | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2f')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { versions?: Record<string, unknown> };
    return Object.keys(body.versions ?? {});
  } catch {
    return null; // offline / rate-limited — reported as unknown, never thrown
  }
}

/** Run `jobs` with a bounded number in flight. */
async function pooled<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wantMajors = args.includes('--majors');
  const asJson = args.includes('--json');

  // One registry query per distinct package, not per declaration site.
  const byPkg = new Map<string, { range: string; from: string[] }>();
  for (const d of collectDeps()) {
    const seen = byPkg.get(d.pkg);
    if (seen) seen.from.push(d.from);
    else byPkg.set(d.pkg, { range: d.range, from: [d.from] });
  }

  const names = [...byPkg.keys()].sort();
  if (!asJson) console.log(`Checking ${names.length} distinct packages against the npm registry…`);

  const unknown: string[] = [];
  const drifts: Drift[] = [];

  await pooled(names, CONCURRENCY, async (pkg) => {
    const entry = byPkg.get(pkg)!;
    const versions = await versionsOf(pkg);
    if (!versions?.length) {
      unknown.push(pkg);
      return;
    }
    const stable = versions.filter((v) => parse(v));
    let latest = stable[0]!;
    for (const v of stable) if (gt(parse(v)!, parse(latest)!)) latest = v;

    let inRange: string | null = null;
    let unsupported = false;
    for (const v of stable) {
      const ok = satisfies(v, entry.range);
      if (ok === null) {
        unsupported = true;
        break;
      }
      if (ok && (!inRange || gt(parse(v)!, parse(inRange)!))) inRange = v;
    }
    if (unsupported) {
      unknown.push(`${pkg} (unsupported range "${entry.range}")`);
      return;
    }

    // Drift = the declared range permits something newer than its own floor,
    // or a major exists outside the range entirely.
    const floor = /^[\^~]?(\d+\.\d+\.\d+)$/.exec(entry.range)?.[1];
    const behindInRange = inRange && floor && gt(parse(inRange)!, parse(floor)!);
    const majorAvailable = inRange !== latest;
    if (behindInRange || majorAvailable) {
      drifts.push({
        pkg,
        range: entry.range,
        from: entry.from,
        inRange,
        latest,
        major: Boolean(majorAvailable),
      });
    }
  });

  const inRangeDrift = drifts.filter(
    (d) => d.inRange && d.inRange !== d.range.replace(/^[\^~]/, ''),
  );
  const majors = drifts.filter((d) => d.major);

  if (asJson) {
    console.log(JSON.stringify({ inRangeDrift, majors, unknown }, null, 2));
    return;
  }

  console.log(`\n── In-range drift (a plain \`pnpm update\` would take these) ──`);
  if (!inRangeDrift.length)
    console.log('  none — every range is resolved to its newest in-range version');
  for (const d of inRangeDrift.sort((a, b) => a.pkg.localeCompare(b.pkg))) {
    console.log(
      `  ${d.pkg.padEnd(34)} ${d.range.padEnd(12)} → ${d.inRange}   [${d.from.join(', ')}]`,
    );
  }

  if (wantMajors) {
    console.log(`\n── Majors outside the declared range (a deliberate migration) ──`);
    if (!majors.length) console.log('  none');
    for (const d of majors.sort((a, b) => a.pkg.localeCompare(b.pkg))) {
      console.log(
        `  ${d.pkg.padEnd(34)} ${d.range.padEnd(12)} → ${d.latest}   [${d.from.join(', ')}]`,
      );
    }
  } else if (majors.length) {
    console.log(
      `\n  (${majors.length} package(s) have a major outside the range — re-run with --majors)`,
    );
  }

  if (unknown.length) {
    console.log(`\n── Not checked ──`);
    for (const u of unknown.sort()) console.log(`  ${u}`);
  }
  console.log('');
}

await main();
