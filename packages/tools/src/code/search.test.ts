/**
 * code_search's matcher: the cap says so, a plain pattern is literal, a bad
 * regex teaches, and a regex that backtracks without end is stopped instead
 * of holding the process. On Bun the regex runs in a process of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUN_LINE_MS,
  REGEX_CHILD_MEMORY_MB,
  REGEX_TIMEOUT_MS,
  runSearch,
  searchFiles,
  TOO_HARD,
} from './search';

const spawned = vi.hoisted(
  () => [] as { command: string; args: string[]; env: unknown; lineMs?: number }[],
);
/** Set: the regex process gets this line limit in place of Bun's, so a test
 *  meets the limit by count, not by a slow line. */
const lineMs = vi.hoisted(() => ({ value: null as number | null }));
vi.mock('node:child_process', async (load) => {
  const real = await load<typeof import('node:child_process')>();
  return {
    ...real,
    // The regex process runs on this Node: its source, without Bun's flags
    // and the kernel limit's sh (the guard's sh is left as it is).
    spawn: (command: string, args: string[], opts: { env?: unknown }) => {
      if (args.at(-2) !== '-e') return real.spawn(command, args, opts as never);
      const seen: (typeof spawned)[number] = { command, args, env: opts.env };
      spawned.push(seen);
      const proc = real.spawn(
        process.execPath,
        ['--input-type=commonjs', '-e', args.at(-1)!],
        opts as never,
      );
      const end = proc.stdin.end.bind(proc.stdin);
      proc.stdin.end = ((data: string) => {
        const job = JSON.parse(data) as { lineLimit?: { ms: number } };
        seen.lineMs = job.lineLimit?.ms;
        if (job.lineLimit && lineMs.value !== null) job.lineLimit.ms = lineMs.value;
        return end(JSON.stringify(job));
      }) as typeof proc.stdin.end;
      return proc;
    },
  };
});

const FILES = {
  'lib/b.ts': 'const a = 1;\nconst b = a + 1;\n',
  'App.tsx': 'export default function App() {\n  return a.b;\n}\n',
};

/** A line and a pattern that backtrack past the timeout on Node and on Bun
 *  (Bun's engine does not give up on this one), on any machine. */
const BACKTRACKS = `${'a'.repeat(200)}!`;
const BACKTRACKER = '^a*a*a*a*a*a*a*a*a*a*a*a*$';

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

  it('runs a regex (in a process) with ignore_case', async () => {
    const res = await searchFiles(FILES, '^CONST \\w = ', {
      regex: true,
      ignoreCase: true,
      cap: 50,
    });
    expect(res).toMatchObject({ total: 2, files: 1 });
  });

  it('a line limit stops on a slow line with no match, and a match stands', () => {
    const job = (text: string, pattern: string) => ({
      files: [['x.ts', text]] as [string, string][],
      pattern,
      regex: true,
      ignoreCase: false,
      cap: 5,
      textMax: 200,
      lineLimit: { ms: 0, error: TOO_HARD },
    });
    expect(() => runSearch(job('abc\nzzz', 'b'))).toThrow(`${TOO_HARD} (at x.ts:2)`);
    expect(runSearch(job('abc', 'b'))).toEqual({ hits: ['x.ts:1: abc'], total: 1, files: 1 });
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
      const res = await searchFiles(files, BACKTRACKER, {
        regex: true,
        ignoreCase: false,
        cap: 50,
      });
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

  it('a line too hard for the engine fails the search: never a wrong no match', async () => {
    lineMs.value = 0;
    try {
      const res = await searchFiles({ 'x.ts': 'abc\nzzz' }, 'q', {
        regex: true,
        ignoreCase: false,
        cap: 50,
      });
      expect(res).toEqual({ error: `${TOO_HARD} (at x.ts:1)` });
      expect(spawned.map((s) => s.lineMs)).toEqual([BUN_LINE_MS]);
    } finally {
      lineMs.value = null;
    }
  });

  it(
    'a backtracking regex is killed at the timeout, and its slot comes back',
    async () => {
      const files = { 'x.ts': BACKTRACKS };
      const started = Date.now();
      const res = await searchFiles(files, BACKTRACKER, {
        regex: true,
        ignoreCase: false,
        cap: 50,
      });
      expect(res).toEqual({ error: expect.stringMatching(/ran past 3s and was stopped/) });
      expect(Date.now() - started).toBeLessThan(REGEX_TIMEOUT_MS + 2000);
      const next = await searchFiles(FILES, 'a', { regex: true, ignoreCase: false, cap: 5 });
      expect(next).toMatchObject({ total: 4 });
    },
    REGEX_TIMEOUT_MS + 5000,
  );
});
