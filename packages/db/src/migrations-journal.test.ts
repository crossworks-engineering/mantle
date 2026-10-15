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

  it('no slot is skipped: a later-added lower number would never run (W7 integration fix 2)', () => {
    // migrate.ts skips an entry whose `when` is at or below the highest one
    // applied, so a gap filled later is skipped on every box that rolled
    // past it. 0211 is the one historical gap, never to be filled. 0290 is
    // reserved (arch A9, the runtime role fix) and lands on main before
    // 0291 (A6 round 2): this branch alone holds the gap until then, and no
    // box takes 0291 without 0290 first.
    const idxs = new Set(journal.entries.map((e) => e.idx));
    const last = Math.max(...idxs);
    const reserved = idxs.has(291) ? [290] : [];
    const gaps: number[] = [];
    for (let i = 0; i <= last; i++) {
      if (!idxs.has(i) && i !== 211 && !reserved.includes(i)) gaps.push(i);
    }
    expect(gaps).toEqual([]);
  });

  it('0270 runs on a database that applied the round-1 0271 (W7 integration fix 3, L5)', () => {
    // The round-1 build shipped 0271_sandboxes_created_by with when
    // 1790195340000; a box that applied it records that stamp, and migrate.ts
    // skips any entry at or below it.
    const e = (journal.entries as unknown as Array<{ tag: string; when: number }>).find(
      (x) => x.tag === '0270_sandboxes_created_by',
    );
    expect(e?.when).toBeGreaterThan(1790195340000);
  });

  it('0270 runs again on a database that applied it before the folded-row repair moved in (W7 integration fix 4)', () => {
    // Fix 3 shipped 0270 with when 1790195400000; a box that applied it
    // records that stamp. The repair of a team row folded with no workspace
    // moved from 0269 into 0270, so 0270 must sit above that stamp, and it
    // must hold the repair (0269 no longer does).
    const e = (journal.entries as unknown as Array<{ tag: string; when: number }>).find(
      (x) => x.tag === '0270_sandboxes_created_by',
    );
    expect(e?.when).toBeGreaterThan(1790195400000);
    const body = (f: string) => readFileSync(join(dir, `${f}.sql`), 'utf8');
    const repair = /UPDATE "public"\."assistant_messages" m\s+SET "agent_id"/;
    expect(body('0270_sandboxes_created_by')).toMatch(repair);
    expect(body('0269_workspaces_user_threads')).not.toMatch(repair);
  });

  it('a migration from 0270 on that alters several tables locks them all in one statement first', () => {
    const late = files.filter((f) => Number(f.slice(0, 4)) >= 270);
    expect(late).toContain('0270_sandboxes_created_by');
    for (const f of late) {
      const body = readFileSync(join(dir, `${f}.sql`), 'utf8')
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('--'))
        .join('\n');
      const altered = new Set(
        [...body.matchAll(/ALTER TABLE\s+(?:IF EXISTS\s+)?(?:"?public"?\.)?"?(\w+)"?/gi)].map((m) =>
          m[1]!.toLowerCase(),
        ),
      );
      if (altered.size < 2) continue;
      const lock = /LOCK TABLE([^;]*?)IN ACCESS EXCLUSIVE MODE/i.exec(body);
      expect(lock, `${f}: one LOCK TABLE for every table it alters`).not.toBeNull();
      const locked = new Set(
        [...lock![1]!.matchAll(/(?:"?public"?\.)?"?(\w+)"?/g)].map((m) => m[1]!.toLowerCase()),
      );
      for (const t of altered) expect(locked.has(t), `${f}: ${t} locked`).toBe(true);
      expect(lock!.index, `${f}: the lock comes before the first ALTER`).toBeLessThan(
        body.search(/ALTER TABLE/i),
      );
    }
  });
});
