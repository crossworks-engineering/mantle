/**
 * The one check of the kit (./kit.ts): every import of a file under ./pkg/
 * (its tests left out) is its own package folder, the contract, a kit file,
 * or a name that is not the repo (`node:`, an npm package).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PIPELINE_KIT_FILES } from './kit';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.dirname(HERE);
const PKG = path.join(HERE, 'pkg');

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) return filesUnder(abs);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [abs] : [];
  });
}

/** Every module name a file imports: `import ... from`, `export ... from`,
 *  `import('...')` and a bare `import '...'`. */
function importsOf(source: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(re)) out.push(m[1]!);
  return out;
}

/** Why an import of `file` is refused, or null. */
function refusal(file: string, spec: string): string | null {
  if (spec.startsWith('@mantle/')) return 'a repo package by name: import the kit by its path';
  if (!spec.startsWith('.')) return null;
  const rel = path.relative(PKG, file).split(path.sep);
  // A file in a package folder owns that folder; the index owns pkg/.
  const own = rel.length > 1 ? path.join(PKG, rel[0]!) : PKG;
  const target = path.resolve(path.dirname(file), spec);
  if (target === own || target.startsWith(own + path.sep)) return null;
  const fromSrc = path.relative(SRC, target).split(path.sep).join('/');
  const kit = new Set(PIPELINE_KIT_FILES.map((f) => f.replace(/\.ts$/, '')));
  return kit.has(fromSrc.replace(/\.ts$/, '')) ? null : `not on the kit list: ${fromSrc}`;
}

describe('the kit', () => {
  it('every kit file is there', () => {
    for (const f of PIPELINE_KIT_FILES) expect(statSync(path.join(SRC, f)).isFile()).toBe(true);
  });

  it('a package imports only its own folder, the contract and the kit', () => {
    const bad: string[] = [];
    for (const file of filesUnder(PKG)) {
      for (const spec of importsOf(readFileSync(file, 'utf8'))) {
        const why = refusal(file, spec);
        if (why) bad.push(`${path.relative(SRC, file)}: '${spec}': ${why}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the check refuses what it must', () => {
    const step = path.join(PKG, 'plan-mspdi', 'step.ts');
    expect(refusal(step, './mspdi')).toBeNull();
    expect(refusal(step, '../../contract')).toBeNull();
    expect(refusal(step, '../../../sheet-to-grid')).toBeNull();
    expect(refusal(step, 'node:fs')).toBeNull();
    expect(refusal(step, '../../../dwg')).toMatch(/not on the kit list: dwg/);
    expect(refusal(step, '../site-tags/step')).toMatch(/not on the kit list/);
    expect(refusal(step, '../../builtin')).toMatch(/not on the kit list/);
    expect(refusal(step, '@mantle/files/sheet-to-grid')).toMatch(/by name/);
    expect(
      importsOf(`import { a } from './x';\nconst m = await import('../y');\nimport './z';`),
    ).toEqual(['./x', '../y', './z']);
  });
});
