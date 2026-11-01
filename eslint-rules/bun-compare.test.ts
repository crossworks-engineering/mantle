import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBaseline, compareRuns, readResults, silentBunExit } from '../scripts/bun-compare.mjs';

const ROOT = join(import.meta.dirname, '..');

/** The most entries scripts/bun-baseline.json may hold. Lower it as the list
 *  shrinks, and never raise it: a new failure on Bun gets fixed, not listed. */
const BASELINE_CEILING = 0;

const baseline = JSON.parse(readFileSync(join(ROOT, 'scripts/bun-baseline.json'), 'utf8')) as {
  bun: string;
  failures: string[];
};

const run = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe('the Bun compare (scripts/bun-compare.mjs)', () => {
  it('reads a report as file and test, with paths from the repo root', () => {
    const report = {
      testResults: [
        {
          name: '/repo/packages/a/a.test.ts',
          status: 'failed',
          assertionResults: [
            { fullName: 'a works', title: 'works', status: 'passed' },
            { fullName: 'a breaks', title: 'breaks', status: 'failed' },
          ],
        },
      ],
    };
    expect([...readResults(report, '/repo')]).toEqual([
      ['packages/a/a.test.ts > a works', 'passed'],
      ['packages/a/a.test.ts > a breaks', 'failed'],
    ]);
  });

  it('keeps a file that failed before any test ran', () => {
    const report = {
      testResults: [{ name: '/repo/b.test.ts', status: 'failed', assertionResults: [] }],
    };
    expect(readResults(report, '/repo').get('b.test.ts > <file>')).toBe('failed');
  });

  it('keeps a file whose hook failed after every test passed', () => {
    const test = { fullName: 'a', title: 'a', status: 'passed' };
    const report = {
      testResults: [{ name: '/repo/h.test.ts', status: 'failed', assertionResults: [test] }],
    };
    const read = readResults(report, '/repo');
    expect(read.get('h.test.ts > a')).toBe('passed');
    expect(read.get('h.test.ts > <file>')).toBe('failed');
  });

  it('names a Bun run that exits badly with no failed test', () => {
    const clean = { bunOnly: [], notRun: [] };
    expect(silentBunExit({ node: 0, bun: 1 }, clean)).toBe(true);
    expect(silentBunExit({ node: 0, bun: 0 }, clean)).toBe(false);
    expect(silentBunExit({ node: 1, bun: 1 }, clean)).toBe(false);
    expect(silentBunExit({ node: 0, bun: 1 }, { bunOnly: ['a'], notRun: [] })).toBe(false);
  });

  it('lets a failure win when two tests share a name', () => {
    const row = (status: string) => ({ fullName: 'row', title: 'row', status });
    const failFirst = {
      testResults: [
        { name: '/r/c.test.ts', status: 'x', assertionResults: [row('failed'), row('passed')] },
      ],
    };
    const failLast = {
      testResults: [
        { name: '/r/c.test.ts', status: 'x', assertionResults: [row('passed'), row('failed')] },
      ],
    };
    expect(readResults(failFirst, '/r').get('c.test.ts > row')).toBe('failed');
    expect(readResults(failLast, '/r').get('c.test.ts > row')).toBe('failed');
  });

  it('names a test that fails on Bun only, and not one that fails on both', () => {
    const node = run({ both: 'failed', onlyBun: 'passed', fine: 'passed' });
    const bun = run({ both: 'failed', onlyBun: 'failed', fine: 'passed' });
    expect(compareRuns(node, bun)).toEqual({ bunOnly: ['onlyBun'], notRun: [] });
  });

  it('counts a test Bun skipped or never reached, so a hang is not a pass', () => {
    const node = run({ skippedOnBun: 'passed', goneOnBun: 'passed', skippedOnBoth: 'pending' });
    const bun = run({ skippedOnBun: 'pending', skippedOnBoth: 'pending' });
    expect(compareRuns(node, bun)).toEqual({
      bunOnly: [],
      notRun: ['goneOnBun', 'skippedOnBun'],
    });
  });

  it('is red on anything the baseline does not list', () => {
    const bun = run({ known: 'failed', fresh: 'failed' });
    const compared = { bunOnly: ['fresh', 'known'], notRun: [] };
    expect(checkBaseline(compared, ['known'], bun)).toEqual({ fresh: ['fresh'], fixed: [] });
  });

  it('counts a not-run test as new too', () => {
    const compared = { bunOnly: [], notRun: ['gone'] };
    expect(checkBaseline(compared, [], run({})).fresh).toEqual(['gone']);
  });

  it('names only an entry that really passed on Bun as fixed', () => {
    const bun = run({ passed: 'passed', stillFails: 'failed', skipped: 'pending' });
    const baselineList = ['passed', 'stillFails', 'skipped', 'gone'];
    const compared = { bunOnly: ['stillFails'], notRun: ['skipped', 'gone'] };
    expect(checkBaseline(compared, baselineList, bun)).toEqual({ fresh: [], fixed: ['passed'] });
  });
});

describe('the Bun baseline (scripts/bun-baseline.json)', () => {
  it('only gets shorter', () => {
    expect(baseline.failures.length).toBeLessThanOrEqual(BASELINE_CEILING);
  });

  it('is sorted, with no entry twice', () => {
    expect(baseline.failures).toEqual([...new Set(baseline.failures)].sort());
  });

  it('names the pinned Bun version', () => {
    expect(baseline.bun).toBe(readFileSync(join(ROOT, '.bun-version'), 'utf8').trim());
  });
});
