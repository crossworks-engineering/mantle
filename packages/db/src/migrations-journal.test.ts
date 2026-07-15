import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every migration .sql file must be registered in meta/_journal.json — the
 * drizzle migrator applies ONLY journaled entries, so an unregistered file is
 * silently skipped and the box reports "Already up to date" while the schema
 * change never lands. This happened for real: 0119_chunk_fts.sql shipped in
 * v0.133.0 without a journal entry; the live code queried the missing column
 * and the fix needed a manual ALTER on a production box (v0.133.1 hotfix).
 * Nothing else in the pipeline catches it — typecheck, the test suite, and
 * `next build` were all green. This test is the guard.
 */
describe('migrations journal', () => {
  const dir = join(__dirname, '..', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.replace(/\.sql$/, ''))
    .sort();
  const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const tags = journal.entries.map((e) => e.tag).sort();

  it('every .sql migration file has a journal entry', () => {
    const missing = files.filter((f) => !tags.includes(f));
    expect(missing).toEqual([]);
  });

  it('every journal entry has a matching .sql file', () => {
    const orphaned = tags.filter((t) => !files.includes(t));
    expect(orphaned).toEqual([]);
  });

  it('journal idx values are unique and sequential', () => {
    const idxs = journal.entries.map((e) => e.idx);
    expect(new Set(idxs).size).toBe(idxs.length);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
  });
});
