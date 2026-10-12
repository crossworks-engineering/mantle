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
import { requestWriteScope } from './viewer';

type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function scopeReadsNodes(tx: Exec, ids: readonly string[]): Promise<Set<string>> {
  const list = [...new Set(ids)].filter((id) => UUID.test(id));
  if (list.length === 0) return new Set();
  const scope = requestWriteScope();
  const ws = scope ? scope.ws.filter((id) => UUID.test(id)) : null;
  const reads = ws
    ? sql`n.read_ws && ${`{${ws.join(',')}}`}::uuid[]`
    : sql`(not "public"."mantle_scope_active"() or n.read_ws && "public"."mantle_scope_ws"())`;
  const rows = (await tx.execute(sql`
    select n.id::text as id from "public"."nodes" n
     where n.id = any(${`{${list.join(',')}}`}::uuid[]) and ${reads}`)) as unknown as {
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

/** The same filter for a table whose rows follow an item (`nodeId`, such as
 *  recall_maps.node_id). */
export function itemReadByWorkspace(ws: string, nodeId: SQLWrapper): SQL {
  return sql`exists (select 1 from "public"."nodes" n
                      where n.id = ${nodeId} and ${ws}::uuid = any(n.read_ws))`;
}
