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
