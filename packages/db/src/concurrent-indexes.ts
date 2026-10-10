/**
 * Indexes built CONCURRENTLY, after the migrations (workspaces plan W3).
 *
 * A migration runs in one transaction, and CREATE INDEX CONCURRENTLY cannot.
 * A plain CREATE INDEX on a busy table blocks every write to it for the whole
 * build, so the indexes a live box must gain without that pause are listed
 * here and built by the runner after the migrations (migrate.ts), each in its
 * own statement:
 *
 *  - present and valid: nothing to do (the common case, one catalog read);
 *  - present but INVALID (a build that was interrupted): dropped
 *    CONCURRENTLY, then built again;
 *  - missing: built CONCURRENTLY.
 *
 * Idempotent and safe to run on every boot. Never inside a transaction.
 * Nothing here starts LLM work.
 */
import type { Sql } from 'postgres';

export interface ConcurrentIndex {
  /** Index name (schema public). */
  name: string;
  /** The CREATE INDEX CONCURRENTLY IF NOT EXISTS statement. */
  create: string;
}

export const CONCURRENT_INDEXES: readonly ConcurrentIndex[] = [
  {
    // The small-scope search path (plan section 3): a scope's items by the
    // workspaces they are granted to. fastupdate keeps grant writes cheap.
    name: 'nodes_read_ws_gin',
    create:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "nodes_read_ws_gin" ON "public"."nodes" ' +
      'USING gin ("read_ws") WITH (fastupdate = on)',
  },
];

/** What happened to each index, for the runner's log. */
export type ConcurrentIndexOutcome = 'present' | 'built' | 'rebuilt';

/** Build every listed index that is missing or invalid. */
export async function ensureConcurrentIndexes(
  sql: Sql,
  list: readonly ConcurrentIndex[] = CONCURRENT_INDEXES,
): Promise<Record<string, ConcurrentIndexOutcome>> {
  const out: Record<string, ConcurrentIndexOutcome> = {};
  for (const ix of list) {
    const rows = await sql<{ valid: boolean }[]>`
      select i.indisvalid as valid
        from pg_index i join pg_class c on c.oid = i.indexrelid
        join pg_namespace s on s.oid = c.relnamespace
       where s.nspname = 'public' and c.relname = ${ix.name}`;
    if (rows[0]?.valid) {
      out[ix.name] = 'present';
      continue;
    }
    if (rows[0]) {
      await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "public"."${ix.name}"`);
    }
    await sql.unsafe(ix.create);
    out[ix.name] = rows[0] ? 'rebuilt' : 'built';
  }
  return out;
}
