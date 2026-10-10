import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { headsBypassesIn } from './heads-bypass';

describe('headsBypassesIn', () => {
  it('finds the named bypasses a migration runs, and nothing in comments', () => {
    expect(
      headsBypassesIn([
        "-- SELECT mantle_heads_bypass('not this one');\nSET LOCAL lock_timeout = '5s';",
        "SELECT mantle_heads_bypass('0250_backfill_x');",
        "select public.mantle_heads_bypass( 'it''s named' )",
      ]),
    ).toEqual(['0250_backfill_x', "it's named"]);
    expect(headsBypassesIn(['UPDATE nodes SET title = title'])).toEqual([]);
  });
});

describe('every shipped migration bypasses under its own tag only', () => {
  it('a bypass name in a migration is that migration', () => {
    const dir = join(__dirname, '..', 'migrations');
    const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    for (const { tag } of journal.entries) {
      const statements = readFileSync(join(dir, `${tag}.sql`), 'utf8').split(
        '--> statement-breakpoint',
      );
      for (const name of headsBypassesIn(statements)) expect(name, tag).toBe(tag);
    }
  });
});
