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
 * 15,000 chunks is about 70 ms). The scope's items are counted once per
 * transaction, bounded (at most the threshold + 1 rows read from the GIN
 * index on nodes.read_ws), and multiplied by the table's rows per node from
 * the planner statistics (pg_class.reltuples). Over the threshold the arms
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

const counted = new WeakMap<WorkspaceScope, Promise<number>>();
let ratios: { at: number; per: Record<ScopeTable, number> } | null = null;
const RATIO_TTL_MS = 10 * 60_000;

/** Rows per node of each table, from the planner statistics (refreshed every
 *  ten minutes per process). A table never analysed counts as one per node. */
async function rowsPerNode(): Promise<Record<ScopeTable, number>> {
  if (ratios && Date.now() - ratios.at < RATIO_TTL_MS) return ratios.per;
  const rows = (await db.execute(sql`
    select relname as t, reltuples::float8 as n from pg_class
     where relnamespace = 'public'::regnamespace
       and relname in ('nodes', 'content_chunks', 'content_chunk_windows', 'facts')
       and relkind = 'r'`)) as unknown as Array<{ t: ScopeTable; n: number }>;
  const of = (t: ScopeTable) => Number(rows.find((r) => r.t === t)?.n ?? -1);
  const nodes = of('nodes');
  const per = (t: ScopeTable) => (nodes > 0 && of(t) >= 0 ? Math.max(of(t) / nodes, 1) : 1);
  ratios = {
    at: Date.now(),
    per: {
      nodes: 1,
      content_chunks: per('content_chunks'),
      content_chunk_windows: per('content_chunk_windows'),
      facts: per('facts'),
    },
  };
  return ratios.per;
}

/**
 * True inside a workspace scope whose rows of `table` number at most
 * scopeExactMaxRows() (estimated: the scope's items, counted, times the
 * table's rows per node). The items are counted once per scope (the frozen
 * scope object lives for one transaction), bounded, on the GIN index.
 */
export async function smallScope(table: ScopeTable = 'nodes'): Promise<boolean> {
  const scope = currentWorkspaceScope();
  const max = scopeExactMaxRows();
  if (!scope || max === 0) return false;
  let p = counted.get(scope);
  if (!p) {
    p = (async () => {
      const rows = (await db.execute(sql`
        select count(*)::int as n from (
          select 1 from nodes where read_ws && mantle_scope_ws()
           limit ${max + 1}) s`)) as unknown as Array<{ n: number }>;
      return Number(rows[0]?.n ?? 0);
    })();
    counted.set(scope, p);
  }
  const items = await p;
  if (items > max) return false;
  return items * (await rowsPerNode())[table] <= max;
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
