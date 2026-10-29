import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { nodes } from './schema/index';
import { currentWorkspaceScope, readsDrafts } from './viewer';
import { UUID_RE } from '@mantle/std';

/** A uuid[] parameter of the scope's workspaces. */
function wsParam(ids: readonly string[]): SQL {
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error(`draft read: not a uuid: ${String(id).slice(0, 40)}`);
  }
  return sql`${`{${ids.join(',')}}`}::uuid[]`;
}

/**
 * Whether the caller's scope may edit the item row in the query, or null
 * outside a workspace scope: mantle_may_edit_in (0280) over the scope the
 * code runs in, never mantle_may_edit over the connection's settings. A
 * login's write transaction (db.transaction in a mutating request or an
 * Admin turn) may run on the plain system pool, which carries no mantle.ws
 * or mantle.mod_ws (the actor check off, the default; a gap rerun in
 * warn): read from the settings, the rule said no there and a locked read
 * saw no draft (stale app builds, dropped draft files, empty publishes).
 * The scope's workspaces are the ones a scoped query sets, so the answer
 * is the same on every pool.
 */
function scopeMayEdit(): SQL<boolean> | null {
  const scope = currentWorkspaceScope();
  if (!scope) return null;
  return sql<boolean>`"public"."mantle_may_edit_in"(${wsParam(scope.ws)}, ${wsParam(scope.modWs)}, ${nodes.homeWs}, ${nodes.writeWs})`;
}

/**
 * A draft column, read only where the caller may read drafts: null below
 * that (readsDrafts() false); the column itself
 * on the system pool or in a personal space; inside a workspace scope the
 * column only for an item the user may edit (a Moderator of its home, or
 * a grant with Write on in the scope: scopeMayEdit), else null. The query
 * must read `nodes` (the item's row) in its FROM.
 */
export function draftColumn<T>(column: AnyPgColumn): SQL<T | null> {
  if (!readsDrafts()) return sql<null>`null`;
  const mayEdit = scopeMayEdit();
  if (mayEdit) {
    return sql<T | null>`case when ${mayEdit} then ${column} end`.mapWith(column) as SQL<T | null>;
  }
  return sql<T | null>`${column}`.mapWith(column) as SQL<T | null>;
}

/** Whether the item row in the query may show its draft to the caller (the
 *  same rule as draftColumn), as a boolean expression. Never for a
 *  read-only snapshot copy: nobody edits it, so no read
 *  repairs it either. */
export function draftAllowed(): SQL<boolean> {
  if (!readsDrafts()) return sql<boolean>`false`;
  const mayEdit = scopeMayEdit();
  if (mayEdit) {
    return sql<boolean>`(coalesce(${mayEdit}, false) and not coalesce(${nodes.data} ? 'snapshot_of', false))`;
  }
  return sql<boolean>`not coalesce(${nodes.data} ? 'snapshot_of', false)`;
}
