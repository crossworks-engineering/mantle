/**
 * code_search's matcher: the cap says so, a plain pattern is literal, a bad
 * regex teaches, and a regex that backtracks without end is stopped instead
 * of holding the process. On Bun the regex runs in a process of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REGEX_CHILD_MEMORY_MB, REGEX_TIMEOUT_MS, searchFiles } from './search';

const spawned = vi.hoisted(() => [] as { command: string; args: string[]; env: unknown }[]);
vi.mock('node:child_process', async (load) => {
  const real = await load<typeof import('node:child_process')>();
  return {
    ...real,
    // The regex process runs on this Node: its source, without Bun's flags
    // and the kernel limit's sh (the guard's sh is left as it is).
    spawn: (command: string, args: string[], opts: { env?: unknown }) => {
      if (args.at(-2) !== '-e') return real.spawn(command, args, opts as never);
      spawned.push({ command, args, env: opts.env });
      return real.spawn(
        process.execPath,
        ['--input-type=commonjs', '-e', args.at(-1)!],
        opts as never,
      );
    },
  };
});

const FILES = {
  'lib/b.ts': 'const a = 1;\nconst b = a + 1;\n',
  'App.tsx': 'export default function App() {\n  return a.b;\n}\n',
};

/** Many lines that each take a moment, so the search passes the timeout on
 *  both engines: one line that took long would meet Bun's line limit first. */
const BACKTRACKS = `${'a'.repeat(19)}!\n`.repeat(2000);
/** One line past Bun's line limit that the regex below does match: Bun's
 *  engine gives up on the first branch and says no match. Node's runs on. */
const HARD_LINE = `${'a'.repeat(27)}!`;

describe('searchFiles', () => {
  it('returns file:line: text hits in path order', async () => {
    const res = await searchFiles(FILES, 'a', { regex: false, ignoreCase: false, cap: 50 });
    expect(res).toMatchObject({ total: 4, files: 2 });
    expect('hits' in res && res.hits[0]).toBe('App.tsx:1: export default function App() {');
    expect('hits' in res && res.hits.at(-1)).toBe('lib/b.ts:2: const b = a + 1;');
  });

  it('caps the hits and keeps the full count', async () => {
    const res = await searchFiles(FILES, 'a', { regex: false, ignoreCase: false, cap: 2 });
    expect(res).toMatchObject({ total: 4 });
    expect('hits' in res && res.hits).toHaveLength(2);
  });

  it('a plain pattern is literal: a dot is a dot', async () => {
    const res = await searchFiles(FILES, 'a.b', { regex: false, ignoreCase: false, cap: 50 });
    expect('hits' in res && res.hits).toEqual(['App.tsx:2:   return a.b;']);
  });

  it('runs a regex (in a worker) with ignore_case', async () => {
    const res = await searchFiles(FILES, '^CONST \\w = ', {
      regex: true,
      ignoreCase: true,
      cap: 50,
    });
    expect(res).toMatchObject({ total: 2, files: 1 });
  });

  it('an invalid regex is an error that says what to do', async () => {
    const res = await searchFiles(FILES, '(', { regex: true, ignoreCase: false, cap: 50 });
    expect(res).toEqual({
      error: expect.stringMatching(/not a valid regular expression.*regex false/),
    });
  });

  it(
    'one caller runs one regex search at a time',
    async () => {
      const slow = { 'x.ts': 'a'.repeat(30) + '!' };
      const first = searchFiles(slow, '^(a+)+$', {
        regex: true,
        ignoreCase: false,
        cap: 5,
        caller: 'c1',
      });
      const second = await searchFiles(FILES, 'a', {
        regex: true,
        ignoreCase: false,
        cap: 5,
        caller: 'c1',
      });
      expect(second).toEqual({
        error: expect.stringMatching(/a regex search of yours is still running/),
      });
      const other = await searchFiles(FILES, 'a', {
        regex: true,
        ignoreCase: false,
        cap: 5,
        caller: 'c2',
      });
      expect(other).toMatchObject({ total: 4 });
      await first;
    },
    REGEX_TIMEOUT_MS + 5000,
  );

  it(
    'a backtracking regex is stopped at the timeout',
    async () => {
      const files = { 'x.ts': BACKTRACKS };
      const started = Date.now();
      const res = await searchFiles(files, '^(a+)+$', { regex: true, ignoreCase: false, cap: 50 });
      expect(res).toEqual({ error: expect.stringMatching(/ran past 3s and was stopped/) });
      expect(Date.now() - started).toBeLessThan(REGEX_TIMEOUT_MS + 2000);
    },
    REGEX_TIMEOUT_MS + 5000,
  );
});

describe('searchFiles on Bun', () => {
  beforeEach(() => {
    spawned.length = 0;
    Object.defineProperty(process.versions, 'bun', { value: '1.4.4', configurable: true });
  });
  afterEach(() => {
    delete (process.versions as { bun?: string }).bun;
  });

  it('a regex runs in a process with no env, under a kernel limit', async () => {
    const res = await searchFiles(FILES, '^CONST \\w = ', {
      regex: true,
      ignoreCase: true,
      cap: 50,
    });
    expect(res).toEqual({
      hits: ['lib/b.ts:1: const a = 1;', 'lib/b.ts:2: const b = a + 1;'],
      total: 2,
      files: 1,
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.env).toEqual({});
    if (process.platform === 'linux') {
      expect(spawned[0]!.command).toBe('/bin/sh');
      expect(spawned[0]!.args).toContain(String(REGEX_CHILD_MEMORY_MB * 1024));
    }
  });

  it(
    'a line too hard for the engine fails the search: never a wrong no match',
    async () => {
      const res = await searchFiles({ 'x.ts': HARD_LINE }, '^(a+)+$|^a+!$', {
        regex: true,
        ignoreCase: false,
        cap: 50,
      });
      expect(res).toEqual({
        error: expect.stringMatching(/too hard for this runtime|ran past 3s/),
      });
    },
    REGEX_TIMEOUT_MS + 5000,
  );

  it(
    'a backtracking regex is killed at the timeout, and its slot comes back',
    async () => {
      const files = { 'x.ts': BACKTRACKS };
      const started = Date.now();
      const res = await searchFiles(files, '^(a+)+$', { regex: true, ignoreCase: false, cap: 50 });
      expect(res).toEqual({ error: expect.stringMatching(/ran past 3s and was stopped/) });
      expect(Date.now() - started).toBeLessThan(REGEX_TIMEOUT_MS + 2000);
      const next = await searchFiles(FILES, 'a', { regex: true, ignoreCase: false, cap: 5 });
      expect(next).toMatchObject({ total: 4 });
    },
    REGEX_TIMEOUT_MS + 5000,
  );
});
