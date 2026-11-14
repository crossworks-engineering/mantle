/**
 * A guard against accidents by our own developers, not a border. Packages
 * are our own code in our own image. The border against a hostile file is
 * the parser jail and `checkStepResult` on the brain side. Accepted, with no
 * rule here: a symlink under ./pkg/, a native or extensionless file,
 * `createRequire`, an aliased `require`, `eval`.
 *
 * The one check of the kit (./kit.ts). Every file under ./pkg/ is walked,
 * whatever its extension; the ones Bun can run as code (ts, tsx, js, jsx,
 * mjs, cjs, mts, cts) are read by Bun's own scanner (`import`, `export from`,
 * `require` and dynamic imports). The tests of a package are left out: a step
 * never loads them. A file that is not code imports nothing.
 *
 * What a step may import:
 *  - a path (relative or absolute) that lands in its own package folder, or
 *    on a kit file (the contract is one);
 *  - a bare name that resolves into node_modules and is not a link to a
 *    workspace package (so `@mantle/...` is refused), or a runtime builtin.
 * A dynamic import or a require whose argument is not a quoted string is
 * refused: it cannot be judged.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PIPELINE_KIT_FILES } from './kit';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.dirname(HERE);
const PKG = path.join(HERE, 'pkg');
const REPO = path.resolve(SRC, '..', '..', '..');

const CODE = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /\.test\.[cm]?[jt]sx?$/;
const KIT = new Set(PIPELINE_KIT_FILES.map((f) => path.join(SRC, f).replace(CODE, '')));
const BUILTINS = new Set(builtinModules);

/** The two calls of Bun this check makes (the tests run on Bun). */
const BUN = (
  globalThis as unknown as {
    Bun: {
      resolveSync(spec: string, from: string): string;
      Transpiler: new (o: { loader: string }) => {
        scanImports(source: string): { path: string; kind: string }[];
      };
    };
  }
).Bun;

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = path.join(dir, name);
    return statSync(abs).isDirectory() ? filesUnder(abs) : [abs];
  });
}

/** Where a bare name lands, or null when it does not resolve. */
function resolveBare(spec: string): string | null {
  try {
    return realpathSync(BUN.resolveSync(spec, PKG));
  } catch {
    return null;
  }
}

/** Why one import of `file` is refused, or null. */
function refusal(file: string, spec: string): string | null {
  if (spec.startsWith('node:') || spec.startsWith('bun:') || BUILTINS.has(spec)) return null;
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    if (/\.test(\.|$)/.test(path.basename(spec))) return 'a test file: the check never reads it';
    const rel = path.relative(PKG, file).split(path.sep);
    // A file in a package folder owns that folder; the index owns pkg/.
    const own = rel.length > 1 ? path.join(PKG, rel[0]!) : PKG;
    const target = path.resolve(path.dirname(file), spec);
    if (target.startsWith(own + path.sep)) return null;
    if (KIT.has(target.replace(CODE, ''))) return null;
    return `not its own folder and not on the kit list: ${path.relative(REPO, target)}`;
  }
  const at = resolveBare(spec);
  if (!at) return 'a name that does not resolve';
  const inModules = at.split(path.sep).includes('node_modules');
  // A workspace link resolves into the repo, never into node_modules.
  return inModules ? null : 'a name that is a package of the repo: import the kit by its path';
}

/** Every refused import of one file, from its source. */
function refusalsOf(file: string, source: string): string[] {
  if (!CODE.test(file) || TEST.test(file)) return [];
  const out: string[] = [];
  // An argument that is not a quoted string cannot be judged.
  for (const m of source.matchAll(/\b(import|require)\s*\(\s*(?!['"])/g)) {
    out.push(`a ${m[1]} whose argument is not a quoted string`);
  }
  const loader = path
    .extname(file)
    .replace(/^\.[cm]?/, '.')
    .slice(1);
  for (const { path: spec } of new BUN.Transpiler({ loader }).scanImports(source)) {
    const why = refusal(file, spec);
    if (why) out.push(`'${spec}': ${why}`);
  }
  return out;
}

describe('the kit', () => {
  it('every kit file is there', () => {
    for (const f of PIPELINE_KIT_FILES) expect(statSync(path.join(SRC, f)).isFile()).toBe(true);
  });

  it('a package imports only its own folder, the kit, and names outside the repo', () => {
    const bad = filesUnder(PKG).flatMap((file) =>
      refusalsOf(file, readFileSync(file, 'utf8')).map(
        (why) => `${path.relative(SRC, file)}: ${why}`,
      ),
    );
    expect(bad).toEqual([]);
  });

  it('the check takes what it must', () => {
    const step = path.join(PKG, 'plan-mspdi', 'step.ts');
    const ok = (src: string, file = step) => expect(refusalsOf(file, src)).toEqual([]);
    ok(`import { a } from './mspdi';`);
    ok(`import { a } from './mspdi.js';`);
    ok(`import { FILE_TABS_WRITE } from '../../contract';`);
    ok(`import { x } from '../../../sheet-to-grid';`);
    ok(`import fs from 'node:fs'; import os from 'os';`);
    ok(`import { describe } from 'vitest';`);
    ok(`const m = await import('./mspdi');`);
    // A data file is not code; a test is never loaded by a step.
    ok(`import { x } from '../../../dwg';`, path.join(PKG, 'plan-mspdi', 'fixtures', 'a.xml'));
    ok(`import { x } from '../../../dwg';`, path.join(PKG, 'plan-mspdi', 'step.test.ts'));
  });

  it('the check refuses what it must', () => {
    const step = path.join(PKG, 'plan-mspdi', 'step.ts');
    const refused = (src: string, file = step) => {
      const out = refusalsOf(file, src);
      expect(out.length, src).toBeGreaterThan(0);
      return out.join('\n');
    };
    expect(refused(`import { x } from '../../../dwg';`)).toMatch(
      /kit list: packages\/files\/src\/dwg/,
    );
    expect(refused(`import { x } from '../site-tags/step';`)).toMatch(/kit list/);
    expect(refused(`import { x } from '../../builtin';`)).toMatch(/kit list/);
    expect(refused(`const d = require('../../../../../db/src/index');`)).toMatch(/kit list/);
    expect(refused(`import x from '/etc/passwd';`)).toMatch(/kit list/);
    expect(refused(`const n = './x'; await import(n);`)).toMatch(/not a quoted string/);
    expect(refused('await import(`../../../dwg`);')).toMatch(/not a quoted string/);
    expect(refused(`const m = require(name);`)).toMatch(/not a quoted string/);
    expect(refused(`import { x } from '@mantle/files/dwg';`)).toMatch(/package of the repo/);
    expect(refused(`import { db } from '@mantle/db';`)).toMatch(/package of the repo/);
    expect(refused(`import x from 'no-such-package-here';`)).toMatch(/does not resolve/);
    // A test is never scanned, so a step may not import one.
    expect(refused(`import { x } from './x.test';`)).toMatch(/a test file/);
    expect(refused(`import { x } from './x.test.ts';`)).toMatch(/a test file/);
    // A .js file of a package is read too.
    const js = path.join(PKG, 'plan-mspdi', 'helper.mjs');
    expect(refused(`export { x } from '../../../dwg.ts';`, js)).toMatch(/kit list/);
  });
});
