import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS module, no types shipped.
import { composeServices, MARK, serverImageCmd, SKIP, stepsOf } from '../scripts/boot-smoke.mjs';
import { BOOT_SMOKE_MARK } from '../packages/config/src/boot-smoke';

/**
 * The guards that came out of the v0.300.64 crash loop (every server process
 * died at start: tsx loaded @mantle/voice-client, which had no "type":
 * "module", as CommonJS, and the names its barrel re-exported vanished).
 *
 *  - Every workspace package declares "type": "module", so tsx never loads
 *    one as CommonJS. A package that cannot is named in TYPE_MODULE_EXEMPT
 *    with the reason.
 *  - The boot smoke (scripts/boot-smoke.mjs, `pnpm boot:smoke`, part of
 *    `pnpm verify` and CI) runs every compose service on the server image;
 *    these tests hold its compose reading and the web entry's lazy loads in
 *    step with the files they read.
 */
const ROOT = join(__dirname, '..');

/** Workspace packages that may leave "type" unset, each with its reason. */
const TYPE_MODULE_EXEMPT: Record<string, string> = {};

/** packages/<name> and server/<name>, each holding a package.json. */
function workspacePackages(): string[] {
  const out: string[] = [];
  for (const dir of ['packages', 'server']) {
    for (const name of readdirSync(join(ROOT, dir))) {
      try {
        readFileSync(join(ROOT, dir, name, 'package.json'));
        out.push(`${dir}/${name}`);
      } catch {
        /* not a package */
      }
    }
  }
  return out.sort();
}

const manifest = (pkg: string) =>
  JSON.parse(readFileSync(join(ROOT, pkg, 'package.json'), 'utf8')) as { type?: string };

describe('every workspace package is an ES module', () => {
  it('declares "type": "module", or is exempt with a reason', () => {
    const packages = workspacePackages();
    expect(packages.length).toBeGreaterThan(20);
    const missing = packages.filter(
      (pkg) => manifest(pkg).type !== 'module' && !(pkg in TYPE_MODULE_EXEMPT),
    );
    expect(missing).toEqual([]);
  });

  it('names no exemption that is stale or unexplained', () => {
    for (const [pkg, why] of Object.entries(TYPE_MODULE_EXEMPT)) {
      expect(manifest(pkg).type, pkg).not.toBe('module');
      expect(why.length, pkg).toBeGreaterThan(20);
    }
  });
});

describe('the boot smoke (scripts/boot-smoke.mjs)', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  const services = composeServices(compose) as { name: string; command: string[] | null }[];
  const byName = new Map(services.map((s) => [s.name, s]));

  it('prints the marker the entries print', () => {
    expect(MARK).toBe(BOOT_SMOKE_MARK);
  });

  it('reads every server-image service of compose, web through the image CMD', () => {
    expect(byName.get('web')?.command).toBeNull();
    expect(serverImageCmd(readFileSync(join(ROOT, 'Dockerfile'), 'utf8'))).toEqual([
      'pnpm',
      '-C',
      'server/web',
      'exec',
      'tsx',
      'server/main.ts',
    ]);
    expect(byName.get('api')?.command).toEqual(['pnpm', '-C', 'server/api', 'start']);
    expect(stepsOf(byName.get('migrate')!.command)).toBe(4);
    // Every service compose runs on the server image, by its block: a block
    // the reader missed would go unsmoked.
    const onImage = [
      ...compose.matchAll(/^ {2}([a-z0-9_]+):\n(?: {4}.*\n)*? {4}image: .*\/mantle-server:/gm),
    ];
    expect(services.map((s) => s.name).sort()).toEqual(onImage.map((m) => m[1]).sort());
    const workers = services.filter((s) => s.name.startsWith('worker_'));
    expect(workers.length).toBeGreaterThanOrEqual(10);
    for (const w of workers)
      expect(w.command?.slice(0, 5), w.name).toEqual(['pnpm', '-C', 'server/web', 'exec', 'tsx']);
  });

  it('skips only services that exist, each with a reason', () => {
    for (const [name, why] of Object.entries(SKIP as Record<string, string>)) {
      expect(byName.has(name), name).toBe(true);
      expect(why.length, name).toBeGreaterThan(20);
    }
  });

  it('loads every module the web entry imports lazily after its checkpoint', () => {
    const main = readFileSync(join(ROOT, 'server/web/server/main.ts'), 'utf8');
    const start = main.indexOf('if (isBootSmoke()) {');
    expect(start).toBeGreaterThan(0);
    const end = main.indexOf('\n}\n', start);
    const specs = (text: string) =>
      new Set([...text.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]!));
    const before = specs(main.slice(0, start));
    const inBlock = specs(main.slice(start, end));
    const after = [...specs(main.slice(end))].filter((s) => !before.has(s) && !inBlock.has(s));
    expect(after).toEqual([]);
  });
});
