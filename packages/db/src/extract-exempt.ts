/**
 * Nodes the extractor never processes, whatever its worker config says: no
 * summary, no embedding, no chunks, no facts, so no LLM or embedding spend.
 *
 * Two kinds today:
 *
 *  - The Forum archive (member logins Phase 6): one admin-level page per
 *    retired forum topic, private topics included, stamped
 *    `data.source = 'forum-archive'` (docs/team-forum.md). Exempt for good.
 *  - A team request a member filed through the team agent
 *    (`team_request_create`), stamped `data.source = 'team-request'`. Its text
 *    is the member's, written before any admin read it, so it is exempt UNTIL
 *    an admin acts on the task (edits it, closes it, or replies to it), which
 *    stamps `data.reviewed_at`. From then on it is an ordinary task. A CLIENT
 *    request (`client_request_create`, client logins C4) is the same, stamped
 *    `data.source = 'client-request'`.
 *
 * Every node insert announces itself on `node_ingested` (migration 0018), so
 * these are still announced; the extractor's admission gate refuses them
 * before any spend, and the boot drain, the missed-event sweep and a
 * repopulating re-embed never pick them up.
 *
 * One rule, two forms: `isExtractExempt` for a loaded node (the gate) and
 * `extractExemptSql` for a query over `nodes` (the drain, the sweep, the
 * re-embed).
 */
import { and, eq, gte, isNull, ne, not, sql, type SQL } from 'drizzle-orm';
import { nodes } from './schema/nodes';

/** `data.source` of a Forum archive page. */
export const FORUM_ARCHIVE_SOURCE = 'forum-archive';

/** `data.source` of a task a member filed through `team_request_create`. */
export const TEAM_REQUEST_SOURCE = 'team-request';

/** `data.source` of a task a CLIENT filed through `client_request_create`
 *  (client logins C4). Client-sourced text: exempt until an admin acts, and a
 *  turn that reads it cannot lower anything without approval. */
export const CLIENT_REQUEST_SOURCE = 'client-request';

/** The sources of requests someone outside the admins wrote. */
export const REQUEST_SOURCES: readonly string[] = [TEAM_REQUEST_SOURCE, CLIENT_REQUEST_SOURCE];

/** True when the extractor must leave this node alone. */
export function isExtractExempt(node: { data: unknown }): boolean {
  const data = (node.data ?? null) as Record<string, unknown> | null;
  if (data?.source === FORUM_ARCHIVE_SOURCE) return true;
  // An unreviewed team or client request: their text, no admin has acted yet.
  return (
    typeof data?.source === 'string' && REQUEST_SOURCES.includes(data.source) && !data.reviewed_at
  );
}

/** The same rule as a condition on `nodes`. */
export function extractExemptSql(): SQL {
  return sql`(coalesce(${nodes.data}->>'source', '') = ${FORUM_ARCHIVE_SOURCE}
    or (coalesce(${nodes.data}->>'source', '') in (${TEAM_REQUEST_SOURCE}, ${CLIENT_REQUEST_SOURCE})
        and coalesce(${nodes.data}->>'reviewed_at', '') = ''))`;
}

/**
 * The nodes the extractor's safety nets re-queue: the owner's non-folder
 * nodes created since `since` that still have no embedding, less the exempt
 * ones. The boot drain uses it as is; the periodic sweep adds "never
 * processed" on top.
 */
export function unextractedNodeConds(ownerId: string, since: Date): SQL {
  return and(
    eq(nodes.ownerId, ownerId),
    ne(nodes.type, 'branch'),
    gte(nodes.createdAt, since),
    isNull(nodes.embedding),
    not(extractExemptSql()),
  )!;
}
