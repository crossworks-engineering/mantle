import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The named heads-check bypass (0244, plan V5) is for migrations only. The
 * database cannot tell the app from the migration runner (both connect as
 * the owner role), so this check keeps every other caller out: no tracked
 * file outside packages/db/migrations/ may name mantle_heads_bypass, except
 * the runner's parser, the database tests that prove it, and this test.
 * W1 audit, LOW 2.
 */
const ALLOWED = new Set([
  'packages/db/src/heads-bypass.ts',
  'packages/db/src/heads-bypass.test.ts',
  'packages/db/src/heads-bypass-callers.test.ts',
]);

describe('mantle_heads_bypass callers', () => {
  it('only migrations call it', () => {
    const root = join(__dirname, '..', '..', '..');
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-l', '-i', 'mantle_heads_bypass'], {
        cwd: root,
        encoding: 'utf8',
      });
    } catch (err) {
      // git grep exits 1 when nothing matches.
      if ((err as { status?: number }).status !== 1) throw err;
    }
    const offenders = out
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean)
      .filter((f) => !f.startsWith('packages/db/migrations/'))
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => !/^packages\/db\/src\/[\w-]+\.db\.test\.ts$/.test(f));
    expect(offenders).toEqual([]);
  });
});
