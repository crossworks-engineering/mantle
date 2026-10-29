/**
 * A live workspace: the one spelling of "not archived". Three forms of the
 * one rule, for the three kinds of query:
 *
 *  - liveWorkspace(): a drizzle condition (`isNull(workspaces.archivedAt)`,
 *    the same SQL the where clauses wrote);
 *  - liveWorkspaceSql(alias): a sql`` fragment, `<alias>.archived_at is null`;
 *  - liveWorkspaceText(alias): the same text for a plain SQL string.
 *
 * The rule has one place to change.
 *
 * eslint-rules/std-helpers.mjs counts every hand spelling (pinned, down
 * only): the ones left are in a plain string (test support) or a
 * postgres.js query.
 */
import { isNull, sql, type SQL } from 'drizzle-orm';
import { workspaces } from './schema/workspaces';

const ALIAS = /^[a-z_][a-z0-9_]*$/;

/** `<alias>.archived_at is null` as text: the workspace row under `alias` is
 *  live (a plain SQL string). */
export function liveWorkspaceText(alias: string): string {
  if (!ALIAS.test(alias)) throw new Error(`liveWorkspaceSql: not an alias: ${alias}`);
  return `${alias}.archived_at is null`;
}

/** `<alias>.archived_at is null`: the workspace row under `alias` is live. */
export function liveWorkspaceSql(alias: string): SQL {
  return sql.raw(liveWorkspaceText(alias));
}

/** The workspaces row is live: a drizzle condition for a where clause over
 *  the `workspaces` table. */
export function liveWorkspace(): SQL {
  return isNull(workspaces.archivedAt);
}
