/**
 * Keyword search under row security (workspaces W3, migration 0249).
 *
 * Under a row rule Postgres uses an index for a condition only when its
 * function is LEAKPROOF. `search_tsv @@ query` runs ts_match_vq, which
 * upstream does not mark, so keyword arms under a limited role scanned the
 * whole table. Migration 0249 marks it (a superuser only); a pg_dump restore
 * does not carry the flag, so the migration runner sets it again after the
 * migrations when it can, and /debug/integrity warns while it is missing.
 * Why it is safe: see the comment in 0249.
 */
import type { Sql } from 'postgres';

/** The function behind `tsvector @@ tsquery`. */
export const TS_MATCH_SIGNATURE = 'pg_catalog.ts_match_vq(tsvector, tsquery)';

/** Whether ts_match_vq is LEAKPROOF on this database. */
export async function tsMatchLeakproof(sql: Sql): Promise<boolean> {
  const [r] = await sql<{ lp: boolean }[]>`
    select proleakproof as lp from pg_proc where oid = 'pg_catalog.ts_match_vq(tsvector, tsquery)'::regprocedure`;
  return r?.lp === true;
}

/**
 * Mark ts_match_vq LEAKPROOF when it is not and the current user is a
 * superuser. 'present', 'set', or 'not-superuser' (nothing changed).
 */
export async function ensureTsMatchLeakproof(
  sql: Sql,
): Promise<'present' | 'set' | 'not-superuser'> {
  if (await tsMatchLeakproof(sql)) return 'present';
  const [me] = await sql<{ su: boolean }[]>`
    select rolsuper as su from pg_roles where rolname = current_user`;
  if (!me?.su) return 'not-superuser';
  await sql`alter function pg_catalog.ts_match_vq(tsvector, tsquery) leakproof`;
  return 'set';
}
