/**
 * Every test file that mocks lib/workspaces with an async factory warms
 * the mock (S9 part 3 round 2, the area fold audit): the shared
 * helper, workspaces-mock.ts, says why. Round 3: the warm-up must be
 * CALLED (an import alone warms nothing), and every way to mock the module
 * is seen: vi.mock and vi.doMock, by a string or by import(...), in a
 * .test.ts or a .test.tsx.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** The module spec of lib/workspaces, as a test spells it. */
const SPEC = String.raw`['"](?:@\/lib\/|(?:\.\.?\/)+(?:lib\/)?)workspaces['"]`;
/** vi.mock or vi.doMock of lib/workspaces (by its spec or import(spec))
 *  with an async factory. */
const MOCKS = new RegExp(
  String.raw`\bvi\.(?:mock|doMock)\(\s*(?:${SPEC}|import\(\s*${SPEC}\s*\))\s*,\s*async\b`,
);
/** The warm-up called: handed to beforeAll, or called itself. */
const CALL = /\bbeforeAll\(\s*warmWorkspacesMock\s*\)|\bwarmWorkspacesMock\(\s*\)/;

/** Whether `text` mocks lib/workspaces with an async factory. */
function mocksWorkspacesAsync(text: string): boolean {
  return MOCKS.test(text);
}

/** Whether `text` calls the warm-up on a line of code (not an import, not
 *  a comment). */
function callsWarmUp(text: string): boolean {
  return text.split('\n').some((line) => {
    const t = line.trim();
    if (t.startsWith('import ') || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) {
      return false;
    }
    return CALL.test(t.replace(/\/\/.*$/, ''));
  });
}

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) testFiles(p, out);
    else if (/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('the warm-up of a mocked lib/workspaces', () => {
  it('every file with an async factory calls warmWorkspacesMock', () => {
    const files = testFiles(join(ROOT, 'server')).filter((f) =>
      mocksWorkspacesAsync(readFileSync(f, 'utf8')),
    );
    const cold = files
      .filter((f) => !callsWarmUp(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    expect(files.length).toBeGreaterThanOrEqual(16);
    expect(cold).toEqual([]);
  });

  it('sees every way to mock the module, and only a call warms it', () => {
    for (const mock of [
      "vi.mock('../lib/workspaces', async (importOriginal) => ({}));",
      "vi.mock('@/lib/workspaces', async () => ({}));",
      'vi.doMock("../../lib/workspaces", async (importOriginal) => ({}));',
      "vi.mock(import('../lib/workspaces'), async (importOriginal) => ({}));",
      "vi.doMock(import('@/lib/workspaces'), async function () { return {}; });",
    ]) {
      expect(mocksWorkspacesAsync(mock), mock).toBe(true);
    }
    // A sync factory runs no import, and another module is not this one.
    expect(mocksWorkspacesAsync("vi.mock('@/lib/workspaces', () => ({}));")).toBe(false);
    expect(mocksWorkspacesAsync("vi.mock('@/lib/list-workspaces', async () => ({}));")).toBe(false);
    expect(callsWarmUp('beforeAll(warmWorkspacesMock);')).toBe(true);
    expect(callsWarmUp('  beforeAll( warmWorkspacesMock );')).toBe(true);
    expect(callsWarmUp('    await warmWorkspacesMock();')).toBe(true);
    // Imported, named or commented: not called.
    expect(callsWarmUp("import { warmWorkspacesMock } from './workspaces-mock';")).toBe(false);
    expect(callsWarmUp('// beforeAll(warmWorkspacesMock);')).toBe(false);
    expect(callsWarmUp(' * then warmWorkspacesMock() in a beforeAll')).toBe(false);
    expect(callsWarmUp('const warm = warmWorkspacesMock;')).toBe(false);
    expect(callsWarmUp('foo(); // warmWorkspacesMock()')).toBe(false);
  });
});
