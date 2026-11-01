/**
 * code_search's matcher: the cap says so, a plain pattern is literal, a bad
 * regex teaches, and a regex that backtracks without end is stopped instead
 * of holding the process.
 */
import { describe, expect, it } from 'vitest';
import { REGEX_TIMEOUT_MS, searchFiles } from './search';

const FILES = {
  'lib/b.ts': 'const a = 1;\nconst b = a + 1;\n',
  'App.tsx': 'export default function App() {\n  return a.b;\n}\n',
};

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
      const files = { 'x.ts': 'a'.repeat(40) + '!' };
      const started = Date.now();
      const res = await searchFiles(files, '^(a+)+$', { regex: true, ignoreCase: false, cap: 50 });
      expect(res).toEqual({ error: expect.stringMatching(/ran past 3s and was stopped/) });
      expect(Date.now() - started).toBeLessThan(REGEX_TIMEOUT_MS + 2000);
    },
    REGEX_TIMEOUT_MS + 5000,
  );
});
