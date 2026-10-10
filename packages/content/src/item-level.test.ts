import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { readAtAliasSql, readAtSql } from './item-level';

/** The team rule asks the grants for an app only (W5b1 audit L4): a page or
 *  a note keeps the level rule, whose embeds-off form the grant (which counts
 *  embeds for non-apps) would widen. Pure: the SQL is rendered, not run. */
const render = (q: ReturnType<typeof sql>) => new PgDialect().sqlToQuery(q).sql;

describe('readAtSql and the Team grant', () => {
  it('takes the grant for an app, the level rule for any other row', () => {
    const team = render(sql`${readAtSql(['team', 'client', 'public'], { embeds: false })}`);
    expect(team).toMatch(
      /case when "nodes"\."type" = 'app' then "public"\."mantle_item_team_reads"\(/,
    );
    expect(team).toMatch(/else \(?"nodes"\."audience" in/);
    expect(team).not.toMatch(/embedded_level" in/);
    const alias = render(
      sql`${readAtAliasSql('n', ['public', 'team', 'client'], { embeds: false })}`,
    );
    expect(alias).toMatch(/case when n\.type = 'app' then "public"\."mantle_item_team_reads"\(/);
  });

  it('keeps the level rule for every other rule', () => {
    for (const q of [
      readAtSql(['team', 'client', 'public']),
      readAtSql(['team', 'client'], { embeds: false }),
      readAtSql(['client'], { embeds: false }),
      readAtAliasSql('n', ['team', 'client', 'public']),
    ]) {
      expect(render(sql`${q}`)).not.toMatch(/mantle_item_team_reads/);
    }
  });
});
