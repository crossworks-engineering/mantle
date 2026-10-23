/**
 * A revert file takes its migration off the ledger by the journal's `when`
 * (drizzle.__drizzle_migrations.created_at). A branch's migration is
 * renumbered at merge (scripts/merge-branch.sh: a `when` above main's
 * last), so the revert's number must follow the journal: each revert that
 * names a `when` names its own migration's, by the tag in its file name.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..');

describe('every revert file names its own migration journal when', () => {
  it('the created_at a revert deletes is the journal when of its tag', () => {
    const journal = JSON.parse(
      readFileSync(join(DIR, 'migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string; when: number }[] };
    const when = new Map(journal.entries.map((e) => [e.tag, e.when]));
    const wrong: string[] = [];
    let checked = 0;
    for (const f of readdirSync(join(DIR, 'rollback')).filter((n) => n.endsWith('.revert.sql'))) {
      const tag = f.slice(0, -'.revert.sql'.length);
      const text = readFileSync(join(DIR, 'rollback', f), 'utf8');
      for (const m of text.matchAll(
        /DELETE FROM "drizzle"\."__drizzle_migrations" WHERE "?created_at"? = (\d+)/gi,
      )) {
        checked++;
        if (Number(m[1]) !== when.get(tag)) {
          wrong.push(`${f}: ${m[1]}, the journal's ${when.get(tag) ?? 'none'}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
    expect(wrong).toEqual([]);
  });
});
