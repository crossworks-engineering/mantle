/**
 * Nodes the extractor never processes, whatever its worker config says: no
 * summary, no embedding, no chunks, no facts, so no LLM or embedding spend.
 *
 * Today that is the Forum archive (member logins Phase 6): one admin-level
 * page per retired forum topic, private topics included, stamped
 * `data.source = 'forum-archive'` (docs/team-forum.md). Every node insert
 * announces itself on `node_ingested` (migration 0018), so the page is still
 * announced; the extractor's admission gate refuses it before any spend, and
 * the boot drain and the missed-event sweep never pick it up again.
 *
 * One rule, two forms: `isExtractExempt` for a loaded node (the gate) and
 * `extractExemptSql` for a query over `nodes` (the drain and the sweep).
 */
import { and, eq, gte, isNull, ne, not, sql, type SQL } from 'drizzle-orm';
import { nodes } from './schema/nodes';

/** `data.source` of a Forum archive page. */
export const FORUM_ARCHIVE_SOURCE = 'forum-archive';

/** True when the extractor must leave this node alone. */
export function isExtractExempt(node: { data: unknown }): boolean {
  const data = (node.data ?? null) as Record<string, unknown> | null;
  return data?.source === FORUM_ARCHIVE_SOURCE;
}

/** The same rule as a condition on `nodes`. */
export function extractExemptSql(): SQL {
  return sql`coalesce(${nodes.data}->>'source', '') = ${FORUM_ARCHIVE_SOURCE}`;
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
