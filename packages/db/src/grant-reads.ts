/**
 * "Does a workspace beyond Admin read this item?" from the grants. Product
 * code asks this instead of reading the level columns (workspaces plan S2;
 * W5b1, and since W5b2 the grants alone).
 *
 * Until migration 0286 this asked about the built-in Team workspace. Team
 * is a normal workspace now (owner decision 2026-10-13) and a new brain has
 * none, so the question is about every workspace other than Admin: the one
 * rule, whatever the workspaces are called.
 *
 * Read where the caller runs: on the system pool every workspace of the
 * brain; in a workspace scope, the workspaces its row rule shows. A brain
 * that is not on workspaces yet has no grants, so nothing reads as shared;
 * it fails closed.
 */
import { sql, type SQL } from 'drizzle-orm';
import { nodes } from './schema/index';

function beyondAdmin(ws: SQL): SQL<boolean> {
  return sql<boolean>`exists (select 1 from "public"."workspaces" w
                               where w.id = any(${ws}) and not w.is_admin)`;
}

/** A workspace beyond Admin reads the row, over `nodes` as drizzle names it. */
export function sharedReadsSql(): SQL<boolean> {
  return beyondAdmin(sql`${nodes.readWs}`);
}

/** The same, over a raw query's alias of `nodes` (`n`). */
export function sharedReadsAliasSql(alias: string): SQL<boolean> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`sharedReadsAliasSql: bad alias ${alias}`);
  }
  return beyondAdmin(sql`${sql.raw(alias)}.read_ws`);
}
