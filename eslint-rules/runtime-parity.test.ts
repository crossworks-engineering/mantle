/**
 * Two settings that do nothing on Bun, with no error. Each stays in the one
 * file that knows it, so a new use cannot pass as a limit that holds.
 *
 *  - a worker's `resourceLimits`: Bun ignores it (a worker took 3.2 GB against
 *    a 64 MB limit). Nothing uses it: a limit needs a process.
 *  - `process.execPath` with no `--no-env-file`: @mantle/std/self-spawn knows
 *    that Bun must not load a .env file into a child. The parser, on Node,
 *    starts its jobs by itself.
 *
 * An Agent `dispatcher` needs no list here: no-bare-fetch holds the load of
 * `undici` to @mantle/std/undici.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './arch-counts.mjs';

const ROOT = resolve(import.meta.dirname, '..');

const productFiles = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      return ['node_modules', 'scripts', '.next', 'dist'].includes(e.name)
        ? []
        : productFiles(path);
    }
    return /\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) ? [path] : [];
  });

const filesWith = (pattern: RegExp): string[] =>
  ['packages', 'server']
    .flatMap(productFiles)
    .filter((f) => pattern.test(stripComments(readFileSync(join(ROOT, f), 'utf8'))))
    .sort();

describe('settings that do nothing on Bun stay in one file', () => {
  it.each([
    'packages/content/src/app-sql-runner.ts',
    'packages/tabledb/src/sql-runner.ts',
    'packages/tools/src/code/search.ts',
  ])('%s, a start outside self-spawn, keeps its env cut', (file) => {
    const runner = readFileSync(join(ROOT, file), 'utf8');
    expect(runner).toMatch(/\[\.\.\.runtimeFlags\(\), '--input-type=commonjs'/);
  });

  it.each([
    'packages/content/src/app-sql-runner.ts',
    'packages/tabledb/src/sql-runner.ts',
    'packages/tools/src/code/search.ts',
  ])('%s gives each child a guard, and hears every error of it', (file) => {
    const runner = readFileSync(join(ROOT, file), 'utf8');
    expect(runner).toMatch(/killWithParent\(proc\)/);
    expect(runner).toMatch(/proc\.on\('error'/);
    expect(runner).not.toMatch(/proc\.once\('error'/);
    expect(runner).toMatch(/withMemoryLimit\(/);
  });

  // These two read every product file: past the default with a full wave of lanes.
  it('a worker limit', () => {
    expect(filesWith(/\bresourceLimits\b/)).toEqual([]);
  }, 60_000);

  it('a start of this runtime', () => {
    expect(filesWith(/\bprocess\.execPath\b/)).toEqual([
      'packages/content/src/app-sql-runner.ts',
      'packages/std/src/self-spawn.ts',
      'packages/tabledb/src/sql-runner.ts',
      'packages/tools/src/code/search.ts',
      'server/parser/src/main.ts',
    ]);
  }, 60_000);
});
