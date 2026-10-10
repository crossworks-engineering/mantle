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

/** What happened to each index, for the runner's log. 'failed': the build
 *  gave up (lock wait, time limit or an error); the next run tries again. */
export type ConcurrentIndexOutcome = 'present' | 'built' | 'rebuilt' | 'failed';

export interface ConcurrentIndexOptions {
  /** Longest wait for a lock (a concurrent build waits for every open
   *  transaction on the table). Default 30 s. */
  lockTimeoutMs?: number;
  /** Longest a build may run. Default 15 min. */
  statementTimeoutMs?: number;
  /** Called with the index name and the error when a build fails. Without
   *  it the error is thrown. */
  onError?: (name: string, err: unknown) => void;
}

/**
 * Build every listed index that is missing or invalid. Each statement runs on
 * one reserved connection with a lock and a statement time limit, so a build
 * can never hold the caller (the migration runner, before boot) for longer
 * than those. A build that fails leaves an INVALID index behind, which is
 * dropped (best effort) so writes do not keep paying for it.
 */
export async function ensureConcurrentIndexes(
  sql: Sql,
  list: readonly ConcurrentIndex[] = CONCURRENT_INDEXES,
  opts: ConcurrentIndexOptions = {},
): Promise<Record<string, ConcurrentIndexOutcome>> {
  const lockMs = Math.max(1, Math.floor(opts.lockTimeoutMs ?? 30_000));
  const stmtMs = Math.max(1, Math.floor(opts.statementTimeoutMs ?? 15 * 60_000));
  const out: Record<string, ConcurrentIndexOutcome> = {};
  const conn = await sql.reserve();
  try {
    await conn`select set_config('lock_timeout', ${`${lockMs}ms`}, false),
                      set_config('statement_timeout', ${`${stmtMs}ms`}, false)`;
    for (const ix of list) {
      const valid = async () =>
        (
          await conn<{ valid: boolean }[]>`
            select i.indisvalid as valid
              from pg_index i join pg_class c on c.oid = i.indexrelid
              join pg_namespace s on s.oid = c.relnamespace
             where s.nspname = 'public' and c.relname = ${ix.name}`
        )[0]?.valid;
      const was = await valid();
      if (was) {
        out[ix.name] = 'present';
        continue;
      }
      const drop = () => conn.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "public"."${ix.name}"`);
      try {
        if (was === false) await drop();
        await conn.unsafe(ix.create);
        out[ix.name] = was === false ? 'rebuilt' : 'built';
      } catch (err) {
        out[ix.name] = 'failed';
        if ((await valid().catch(() => undefined)) === false) await drop().catch(() => undefined);
        if (!opts.onError) throw err;
        opts.onError(ix.name, err);
      }
    }
  } finally {
    await conn`reset lock_timeout`.catch(() => undefined);
    await conn`reset statement_timeout`.catch(() => undefined);
    conn.release();
  }
  return out;
}
