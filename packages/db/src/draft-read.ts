import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { nodes } from './schema/index';
import { currentWorkspaceScope, readsDrafts } from './viewer';

/**
 * A draft column, read only where the caller may read drafts (workspaces
 * W6a, plan 14): null below that (readsDrafts() false); the column itself
 * on the system pool or in a personal space; inside an Admin user's request
 * scope the column only for an item the user may edit
 * (mantle_may_edit(home_ws, write_ws): a Moderator of its home, or a grant
 * with Write on in the scope), else null. The query must read `nodes` (the
 * item's row) in its FROM.
 */
export function draftColumn<T>(column: AnyPgColumn): SQL<T | null> {
  if (!readsDrafts()) return sql<null>`null`;
  if (currentWorkspaceScope()) {
    return sql<T | null>`case when "public"."mantle_may_edit"(${nodes.homeWs}, ${nodes.writeWs}) then ${column} end`.mapWith(
      column,
    ) as SQL<T | null>;
  }
  return sql<T | null>`${column}`.mapWith(column) as SQL<T | null>;
}

/** Whether the item row in the query may show its draft to the caller (the
 *  same rule as draftColumn), as a boolean expression. */
export function draftAllowed(): SQL<boolean> {
  if (!readsDrafts()) return sql<boolean>`false`;
  if (currentWorkspaceScope()) {
    return sql<boolean>`coalesce("public"."mantle_may_edit"(${nodes.homeWs}, ${nodes.writeWs}), false)`;
  }
  return sql<boolean>`true`;
}
