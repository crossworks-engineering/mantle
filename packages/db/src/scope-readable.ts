/**
 * Which of some items the caller's scope reads, asked inside a write
 * transaction (workspaces arch A1 fix round, L1). A login's write runs on
 * the system pool with its scope set on the transaction (mantle.ws, see
 * withSystemTx); a lookup there sees every row, so a write that reports on
 * OTHER items (a warning naming a map, a target that is "gone") must ask
 * this first, or it tells the caller about items outside its scope.
 *
 * The rule is the workspace role's read rule on nodes (0242): the item's
 * read workspaces meet the scope. The scope is the request's write scope
 * when there is one (a plain db.transaction in a request sets nothing on
 * the transaction), else the one set on the transaction (withSystemTx, a
 * turn). With neither (the system's own work, an Admin user on a brain not
 * on workspaces) every item counts as read, as before.
 */
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { nodes } from './schema/nodes';
import { currentGateScope, currentWorkspaceScope, requestWriteScope } from './viewer';
import { currentActor } from './actor';

type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The read rule on a nodes row aliased `alias` (see scopeReadsNodes). The
 *  scope functions sit in sub-selects, as in the row rules: read once per
 *  statement, not once per row. */
function scopeReads(alias = 'n'): SQL {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`bad alias: ${alias}`);
  const a = sql.raw(alias);
  const scope = requestWriteScope();
  const ws = scope ? scope.ws.filter((id) => UUID.test(id)) : null;
  return ws
    ? sql`${a}.read_ws && ${`{${ws.join(',')}}`}::uuid[]`
    : sql`(not (select "public"."mantle_scope_active"())
           or ${a}.read_ws && (select "public"."mantle_scope_ws"()))`;
}

/**
 * The same rule on a `nodes` row aliased `alias` in a hand-written query,
 * for a read that may run on the system pool inside a login's write (the
 * reply of a folder write, a move's confirm list; task b6e4a8aa): only
 * what the caller's scope reads. A read in a workspace scope already has
 * it from the row rules; with no scope at all (the system's own work) it
 * keeps every row.
 */
export function nodeAliasScopeReads(alias: string): SQL {
  return scopeReads(alias);
}

/** The same rule as a condition on a table whose rows follow an item
 *  (`nodeId`, such as recall_maps.node_id), to fold into a query. */
export function scopeReadsItem(nodeId: SQLWrapper): SQL {
  return sql`exists (select 1 from "public"."nodes" n where n.id = ${nodeId} and ${scopeReads()})`;
}

export async function scopeReadsNodes(tx: Exec, ids: readonly string[]): Promise<Set<string>> {
  const list = [...new Set(ids)].filter((id) => UUID.test(id));
  if (list.length === 0) return new Set();
  const rows = (await tx.execute(sql`
    select n.id::text as id from "public"."nodes" n
     where n.id = any(${`{${list.join(',')}}`}::uuid[]) and ${scopeReads()}`)) as unknown as {
    id: string;
  }[];
  return new Set(rows.map((r) => r.id));
}

/** The list filter `?ws=<id>` (W5b2): only the items workspace `ws` reads,
 *  as a condition on a query of `nodes`. `ws` is a checked id
 *  (parseWsFilter). */
export function nodeReadByWorkspace(ws: string): SQL {
  return sql`${ws}::uuid = any(${nodes.readWs})`;
}

/** The same filter on a `nodes` row aliased `alias` in a hand-written
 *  query (the item tree's reads, packages/content/src/tree/read.ts). */
export function nodeAliasReadByWorkspace(ws: string, alias: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`bad alias: ${alias}`);
  return sql`${ws}::uuid = any(${sql.raw(alias)}.read_ws)`;
}

/** The same filter for a table whose rows follow an item (`nodeId`, such as
 *  recall_maps.node_id). */
export function itemReadByWorkspace(ws: string, nodeId: SQLWrapper): SQL {
  return sql`exists (select 1 from "public"."nodes" n
                      where n.id = ${nodeId} and ${ws}::uuid = any(n.read_ws))`;
}

/**
 * Whether the caller must not learn from a write's answer which items exist
 * outside what it reads: then a brain-wide unique name (a Recall map's slug)
 * takes a random suffix instead of the next free number. The answer depends
 * on the caller only, never on the items it cannot read.
 *
 *  - A scope surrounds the call (the request's write scope, the current
 *    workspace scope, the gate scope of the rollback switch, or one set on
 *    the transaction): yes unless that scope holds the Admin workspace.
 *  - No scope seen: the next free number only for a system actor and for
 *    login(owner), which reads every item; any other actor, and none, takes
 *    the random suffix. A scope can be hidden here: inside a system
 *    transaction (withNodeInsertHeads, asSystem) the request's and the
 *    turn's scopes are masked, so a member's assistant that makes a map
 *    reaches this branch (A2b1 audit, M3). The actor rule does not depend
 *    on the check's mode for an entry that binds one actor in every mode.
 *    A2b2 revisits it once every scoped write carries its scope.
 */
export async function scopeLacksAdmin(tx: Exec): Promise<boolean> {
  const scope = requestWriteScope() ?? currentWorkspaceScope() ?? currentGateScope();
  if (scope) {
    const ws = scope.ws.filter((id) => UUID.test(id));
    if (ws.length === 0) return true;
    const rows = (await tx.execute(sql`
      select exists (select 1 from "public"."workspaces" w
                      where w.is_admin and w.id = any(${`{${ws.join(',')}}`}::uuid[])) as a`)) as unknown as {
      a: boolean;
    }[];
    return rows[0]?.a !== true;
  }
  const rows = (await tx.execute(sql`
    select "public"."mantle_scope_active"() as active,
           ("public"."mantle_scope_active"()
            and not exists (select 1 from "public"."workspaces" w
                             where w.is_admin and w.id = any("public"."mantle_scope_ws"()))) as narrow`)) as unknown as {
    active: boolean;
    narrow: boolean;
  }[];
  if (rows[0]?.active === true) return rows[0].narrow === true;
  const actor = currentActor();
  if (actor?.kind === 'system') return false;
  return !(actor?.kind === 'login' && actor.mode === 'owner');
}
