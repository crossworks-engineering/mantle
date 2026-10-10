/**
 * "Does the Team workspace read this item?" from the grants (workspaces plan
 * S2, phase W5b1). Product code asks this instead of reading the level
 * columns.
 *
 * The answer is mantle_item_team_reads (migration 0256): the Team grant for a
 * brain item of a migrated brain, else the level rule, for the rows that have
 * no grants yet (a brain never migrated, a personal-space row). That fallback
 * is the reason the level columns appear below: this file is on the
 * level-reads sweep's allowlist, and W5b2 (bridge off) with W6b removes it.
 */
import { sql, type SQL } from 'drizzle-orm';
import { nodes } from './schema/index';

/** The brain's Team workspace, once per query (an init plan). */
const TEAM_WS = sql`(select "public"."mantle_brain_team_ws"())`;

/** Team reads the row, over `nodes` as drizzle names it. */
export function teamReadsSql(): SQL<boolean> {
  return sql<boolean>`"public"."mantle_item_team_reads"(${nodes.readWs}, ${nodes.homeWs}, ${nodes.type}, ${nodes.audience}, ${nodes.inheritedLevel}, ${nodes.embeddedLevel}, ${TEAM_WS})`;
}

/** Team reads the row, over a raw query's alias of `nodes` (`n`). */
export function teamReadsAliasSql(alias: string): SQL<boolean> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`teamReadsAliasSql: bad alias ${alias}`);
  const a = sql.raw(alias);
  return sql<boolean>`"public"."mantle_item_team_reads"(${a}.read_ws, ${a}.home_ws, ${a}.type, ${a}.audience, ${a}.inherited_level, ${a}.embedded_level, ${TEAM_WS})`;
}
