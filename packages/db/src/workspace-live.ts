/**
 * A live workspace (A10 #15): the one spelling of "not archived" in SQL,
 * where `w.archived_at is null` was written by hand in about twenty-five
 * queries. The text is the same as before (`<alias>.archived_at is null`),
 * so a query reads exactly as it did; the rule has one place to change.
 *
 * eslint-rules/std-helpers.mjs counts the hand spelling (pinned, down only):
 * the ones left are in a plain string (test support) or a postgres.js query.
 */
import { sql, type SQL } from 'drizzle-orm';

const ALIAS = /^[a-z_][a-z0-9_]*$/;

/** `<alias>.archived_at is null`: the workspace row under `alias` is live. */
export function liveWorkspaceSql(alias: string): SQL {
  if (!ALIAS.test(alias)) throw new Error(`liveWorkspaceSql: not an alias: ${alias}`);
  return sql.raw(`${alias}.archived_at is null`);
}
