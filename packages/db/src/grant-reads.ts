/**
 * "Does the Team workspace read this item?" from the grants (workspaces plan
 * S2; W5b1, and since W5b2 the grants alone). Product code asks this instead
 * of reading the level columns.
 *
 * The answer is "the item's Team workspace is in its read_ws". No level
 * fallback is left (bridge off, migration 0261): a brain that is not migrated
 * yet has no Team, so nothing reads as Team's; a personal-space row has no
 * grants until W6b (it is read on the space role, never through Team), so it
 * reads as not Team's either. Both fail closed.
 *
 * The Team workspace: on the system pool, the one of the row's owner (a
 * test's own brain too); on a viewer role, which never reads the workspaces
 * table, the brain's (mantle_brain_team_ws, granted to every viewer role).
 * The two are the same on a box, which has one brain.
 */
import { sql, type SQL } from 'drizzle-orm';
import { nodes } from './schema/index';
import { isSystemScope } from './viewer';

function teamWsOf(owner: SQL): SQL {
  if (isSystemScope()) {
    return sql`(select w.id from "public"."workspaces" w where w.owner_id = ${owner} and w.bridge_key = 'team')`;
  }
  return sql`(select "public"."mantle_brain_team_ws"())`;
}

/** Team reads the row, over `nodes` as drizzle names it. */
export function teamReadsSql(): SQL<boolean> {
  return sql<boolean>`coalesce(${teamWsOf(sql`${nodes.ownerId}`)} = any(${nodes.readWs}), false)`;
}

/** Team may edit the row (its grant's Write switch), over `nodes`. */
export function teamWritesSql(): SQL<boolean> {
  return sql<boolean>`coalesce(${teamWsOf(sql`${nodes.ownerId}`)} = any(${nodes.writeWs}), false)`;
}

/** Team reads the row, over a raw query's alias of `nodes` (`n`). */
export function teamReadsAliasSql(alias: string): SQL<boolean> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`teamReadsAliasSql: bad alias ${alias}`);
  const a = sql.raw(alias);
  return sql<boolean>`coalesce(${teamWsOf(sql`${a}.owner_id`)} = any(${a}.read_ws), false)`;
}
