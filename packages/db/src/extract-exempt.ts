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
 * A TERMINAL skip: the extractor read the node and found nothing it can index
 * (no parser for the format, a body under the minimum, a blank scan, a type
 * the worker does not extract). `data.extract_skipped = { reason, at }`.
 *
 * Without it such a node has no embedding forever, so the boot drain (and the
 * provider circuit's recovery drain, which is the same query) re-queued it on
 * every restart and every recovery: a job and a trace each time, and a vision
 * or OCR call each time for an image or a scan. NATREF, 2026-10-04: one .exe
 * file, 16 jobs in 3 days; in September 75 short files had 24,605 runs.
 *
 * The stamp holds only while the node is unchanged: a write that bumps
 * `updated_at` (an edit, new bytes, a rename) makes it stale, and the drain
 * picks the node up once more, so a missed notify on a content change still
 * self-heals. The gate never reads the stamp: an explicit notify (an edit, a
 * manual re-extract, a stored PDF password) always runs. A successful pass
 * removes it.
 *
 * A machinery failure (a vision worker that did not run, a rasterizer that
 * threw, a failed embed) is NOT terminal: the drain must retry it once the
 * provider is back.
 */
export const EXTRACT_SKIPPED_KEY = 'extract_skipped';

/** Skip dispositions that are always a verdict on the CONTENT, never on the
 *  machinery. The cleanup script (scripts/extract-skip-stamp.ts) stamps old
 *  looping nodes by these; the extractor stamps them as it records them. The
 *  vision and OCR verdicts (`no_vision_text`, `no_text_layer`) are terminal
 *  only when the worker really ran, which an old trace cannot always show, so
 *  they are not in this list. */
export const TERMINAL_EXTRACT_SKIPS: readonly string[] = [
  'needs_export',
  'unsupported_media',
  'no_parser',
  'body_too_short',
  'encrypted_pdf',
  'bytes_unavailable',
  'type_not_in_allowlist',
  'conversation_digest',
  'chat_archive',
];

/** The jsonb to merge onto `nodes.data` for a terminal skip. `at` is the
 *  database clock, the same clock the drain compares with `updated_at`. */
export function extractSkippedStamp(reason: string): SQL {
  return sql`jsonb_build_object(${EXTRACT_SKIPPED_KEY}::text, jsonb_build_object('reason', ${reason}::text, 'at', now()))`;
}

/** True on `nodes` when a terminal skip stamp is current: stamped at or after
 *  the node's last write. */
export function extractSkippedSql(): SQL {
  return sql`coalesce((${nodes.data}->${EXTRACT_SKIPPED_KEY}->>'at')::timestamptz >= ${nodes.updatedAt}, false)`;
}

/**
 * The nodes the extractor's safety nets re-queue: the owner's non-folder
 * nodes WRITTEN since `since` that still have no embedding, less the exempt
 * ones and less those with a current terminal skip. The boot drain uses it as
 * is; the periodic sweep adds `noExtractSinceWriteSql` on top.
 *
 * The window is on `updated_at`, not `created_at`. A content change nulls the
 * embedding and fires a notify; when that notify is lost (the agent was down,
 * e.g. the docs sync at web boot during a roll), an OLD node must still be
 * picked up. On `created_at` it never was: dev, 2026-10-05, 365 documentation
 * nodes created in July/August sat without a summary or an embedding.
 */
export function unextractedNodeConds(ownerId: string, since: Date): SQL {
  return and(
    eq(nodes.ownerId, ownerId),
    ne(nodes.type, 'branch'),
    gte(nodes.updatedAt, since),
    isNull(nodes.embedding),
    not(extractExemptSql()),
    not(extractSkippedSql()),
  )!;
}

/**
 * True on `nodes` when no extractor run has finished since the node's last
 * write: the missed-event signature. The periodic sweep's extra clause.
 *
 * Loop-safe: every run (success, skip or failure) writes its trace's
 * `finished_at` AFTER any write it made to the node, so once a run has
 * processed the current version the node drops out, embedding or not. Only a
 * new write (which normally fires its own notify) brings it back. The old
 * clause, "no extractor_run at all", missed every node that had been
 * extracted once and then changed.
 */
export function noExtractSinceWriteSql(): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM public.traces t WHERE t.subject_id = ${nodes.id}
    AND t.kind = 'extractor_run'
    AND coalesce(t.finished_at, t.created_at) >= ${nodes.updatedAt})`;
}
