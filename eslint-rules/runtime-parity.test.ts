/**
 * Two settings that do nothing on Bun, with no error. Each stays in the one
 * file that knows it, so a new use cannot pass as a limit that holds.
 *
 *  - a worker's `resourceLimits`: Bun ignores it (a worker took 3.2 GB against
 *    a 64 MB limit). draw-png.ts uses it on Node, and a process on Bun.
 *  - `process.execPath` with Node's arguments: @mantle/std/self-spawn knows the
 *    runtime, and that Bun must not load a .env file into a child.
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
  it('the app SQL runner, the one start outside self-spawn, keeps its env cut', () => {
    const runner = readFileSync(join(ROOT, 'packages/content/src/app-sql-runner.ts'), 'utf8');
    expect(runner).toMatch(/\[\.\.\.runtimeFlags\(\), '--input-type=commonjs'/);
  });

  it('a worker limit', () => {
    expect(filesWith(/\bresourceLimits\b/)).toEqual(['packages/content/src/draw-png.ts']);
  });

  it('a start of this runtime', () => {
    expect(filesWith(/\bprocess\.execPath\b/)).toEqual([
      'packages/content/src/app-sql-runner.ts',
      'packages/std/src/self-spawn.ts',
    ]);
  });
});
