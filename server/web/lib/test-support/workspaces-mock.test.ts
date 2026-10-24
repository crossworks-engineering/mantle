/**
 * Every test file that mocks lib/workspaces with an async factory warms
 * the mock (S9 part 3 round 2, the area fold audit): the shared
 * helper, workspaces-mock.ts, says why.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MOCKS = /vi\.mock\(\s*['"](?:@\/lib\/|(?:\.\.?\/)+(?:lib\/)?)workspaces['"]\s*,\s*async\b/;

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) testFiles(p, out);
    else if (e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('the warm-up of a mocked lib/workspaces', () => {
  it('every file with an async factory calls warmWorkspacesMock', () => {
    const files = testFiles(join(ROOT, 'server')).filter((f) =>
      MOCKS.test(readFileSync(f, 'utf8')),
    );
    const cold = files
      .filter((f) => !readFileSync(f, 'utf8').includes('warmWorkspacesMock'))
      .map((f) => relative(ROOT, f));
    expect(files.length).toBeGreaterThanOrEqual(16);
    expect(cold).toEqual([]);
  });
});
