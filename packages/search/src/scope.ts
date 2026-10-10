/**
 * The small-scope exact path (workspaces plan section 3, phase W3).
 *
 * Under a workspace scope, row security keeps the rows whose node the scope
 * reads. An HNSW scan walks the WHOLE graph and drops the rows the rule
 * hides, so for a scope that holds a small share of a big brain it returns
 * short or poor results (recall@50 was 0.54 for a client role in the
 * 2026-09 spike) and walks far to fill its pool. For such a scope the vector
 * arms search exactly instead: the scope's items by the GIN index on
 * nodes.read_ws, then their chunks, windows or facts by node id, ordered by
 * the true distance. A few thousand vectors are a few milliseconds.
 *
 * "Small" is in ROWS of the table the arm searches, not in items: a scope
 * of 400 sermons holds 13,000 chunks and 34,000 windows, and the exact
 * search costs per row (the W3 bench: about 5 microseconds a chunk, so
 * 15,000 chunks is about 70 ms). The scope's items (on the GIN index on
 * nodes.read_ws) and then their rows in the searched table (by node id) are
 * counted once per transaction, each bounded at the threshold + 1. Over the
 * threshold the arms
 * use HNSW, pinned to the index order (hnsw.ts). Outside a workspace scope
 * (the system pool, a level role, a personal space) nothing here applies.
 */
import { sql, type SQL } from 'drizzle-orm';
import { currentWorkspaceScope, db, type WorkspaceScope } from '@mantle/db';
import { env } from '@mantle/config';

/** The tables a vector arm searches. */
export type ScopeTable = 'nodes' | 'content_chunks' | 'content_chunk_windows' | 'facts';

/** The most rows the exact path may search (the W3 bench set it).
 *  MANTLE_SCOPE_EXACT_MAX_ROWS tunes it per box; 0 turns the exact path off. */
export function scopeExactMaxRows(): number {
  const n = Math.floor(Number(env('MANTLE_SCOPE_EXACT_MAX_ROWS') ?? 15000));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const counted = new WeakMap<WorkspaceScope, Map<ScopeTable, Promise<number>>>();

/** The scope's items, as one array (at most `cap`, on the GIN index). */
function scopeItems(cap: number): SQL {
  return sql`array(select id from nodes where read_ws && mantle_scope_ws() limit ${cap})`;
}

/** The scope's rows of `table`, counted up to `cap` (an index read per item:
 *  the node index of chunks and windows, the source index of facts). */
function countRows(table: ScopeTable, cap: number): SQL {
  switch (table) {
    case 'nodes':
      return sql`select count(*)::int as n from (
        select 1 from nodes where read_ws && mantle_scope_ws() limit ${cap}) s`;
    case 'content_chunks':
      return sql`select count(*)::int as n from (
        select 1 from content_chunks where node_id = any(${scopeItems(cap)}) limit ${cap}) s`;
    case 'content_chunk_windows':
      return sql`select count(*)::int as n from (
        select 1 from content_chunk_windows where node_id = any(${scopeItems(cap)}) limit ${cap}) s`;
    case 'facts':
      // A fact with a source counts with its node; one without (learned in
      // chat) by its own read_ws.
      return sql`select count(*)::int as n from (
        (select 1 from facts where source_node_id = any(${scopeItems(cap)}) limit ${cap})
        union all
        (select 1 from facts where source_node_id is null and read_ws && mantle_scope_ws() limit ${cap})
        limit ${cap}) s`;
  }
}

/**
 * True inside a workspace scope whose rows of `table` number at most
 * scopeExactMaxRows(). Counted, not estimated: the scope's items on the GIN
 * index, then their rows in `table` by node id, each bounded at the
 * threshold + 1, so a chunk-heavy scope is measured as it is and not by the
 * brain's average. Once per scope and table (the frozen scope object lives
 * for one transaction).
 */
export async function smallScope(table: ScopeTable = 'nodes'): Promise<boolean> {
  const scope = currentWorkspaceScope();
  const max = scopeExactMaxRows();
  if (!scope || max === 0) return false;
  let byTable = counted.get(scope);
  if (!byTable) {
    byTable = new Map();
    counted.set(scope, byTable);
  }
  const cache = byTable;
  const count = (t: ScopeTable): Promise<number> => {
    let p = cache.get(t);
    if (!p) {
      p = (async () => {
        const rows = (await db.execute(countRows(t, max + 1))) as unknown as Array<{ n: number }>;
        return Number(rows[0]?.n ?? 0);
      })();
      cache.set(t, p);
    }
    return p;
  };
  // Too many items is too many rows (and too long an id list) for any table.
  if ((await count('nodes')) > max) return false;
  return table === 'nodes' || (await count(table)) <= max;
}

/** The ids of the scope's items of `ownerId`, as one array (the exact path's
 *  filter: `<row>.node_id = any(...)` uses the row table's node index). */
export function scopeNodeIds(ownerId: string): SQL {
  return sql`array(select id from nodes where read_ws && mantle_scope_ws() and owner_id = ${ownerId})`;
}

/** The ORDER BY of a vector arm: the bare distance (HNSW-eligible), or on the
 *  exact path the same distance in a form no index serves, so the planner
 *  sorts the scope's rows by their true distance. */
export function distanceOrder(dist: SQL, exact: boolean): SQL {
  return exact ? sql`(${dist}) + 0` : dist;
}

/** Whether a vector arm must be kept on the HNSW order (hnsw.ts): under a
 *  workspace scope that is not on the exact path. */
export function hnswFirst(exact: boolean): boolean {
  return !exact && currentWorkspaceScope() !== null;
}
