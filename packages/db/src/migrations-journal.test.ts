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

  it('journal when values are strictly increasing (the migrator GATES on them)', () => {
    // migrate.ts applies only entries whose `when` exceeds the max recorded
    // created_at — an entry stamped with a when ≤ its predecessor is silently
    // skipped on every box that already ran the predecessor. This happened
    // for real too (v0.133.1 stamped 0119 below 0118; fixed in v0.133.2).
    const whens = (journal.entries as unknown as Array<{ when: number }>).map((e) => e.when);
    for (let i = 1; i < whens.length; i++) {
      expect(whens[i]!, `entry ${i} when must exceed entry ${i - 1}`).toBeGreaterThan(
        whens[i - 1]!,
      );
    }
  });

  it('no two migrations claim the same number', () => {
    // The migration number is a GLOBAL COUNTER claimed by sessions that cannot
    // see each other — and worktrees make parallel sessions the norm. Two lines
    // of work both reached for 0138: the v0.206.0 merge had to renumber
    // team_notifications 0138 -> 0140 by hand, and its `when` had to be stamped
    // after 0139 because the runner gates on `when` and the workstation dev DB
    // already carried the sandboxes stamps. Nothing caught the clash; a human
    // noticed. This is that check — it fires at merge time, in `pnpm verify`.
    const byNumber = new Map<string, string[]>();
    for (const f of files) {
      const n = f.slice(0, 4);
      byNumber.set(n, [...(byNumber.get(n) ?? []), f]);
    }
    const clashes = [...byNumber.entries()].filter(([, fs]) => fs.length > 1);
    expect(
      clashes,
      clashes.length
        ? `two migrations share a number — rename the later one to the next free ` +
            `number and stamp its journal \`when\` AFTER its new predecessor (the ` +
            `migrator gates on when, so a lower stamp is silently skipped): ` +
            clashes.map(([n, fs]) => `${n} -> ${fs.join(' + ')}`).join('; ')
        : '',
    ).toEqual([]);
  });

  it('every journal idx matches the number in its tag', () => {
    // A renumber touches two places: the .sql filename and the journal entry.
    // Doing one and not the other leaves a journal that looks internally
    // consistent — idx unique, sequential, `when` increasing — while pointing
    // at a differently-numbered file. That is exactly the state a badly
    // resolved _journal.json merge conflict produces, and the add/add conflict
    // in this file is a known recurring one.
    const mismatched = journal.entries
      .filter((e) => Number(e.tag.slice(0, 4)) !== e.idx)
      .map((e) => `idx ${e.idx} <-> ${e.tag}`);
    expect(
      mismatched,
      `journal idx and filename number disagree — a half-finished renumber, or a ` +
        `mis-resolved _journal.json merge: ${mismatched.join('; ')}`,
    ).toEqual([]);
  });
});
