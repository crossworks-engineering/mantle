/**
 * Extractor: the admission gate.
 *
 * Everything `extractNode` decides BEFORE it is willing to spend an LLM call,
 * in the order it decides it. Cut out of extractor.ts on 2026-09-03 (the
 * audit-of-audit: the 2026-09-02 bloat pass moved helpers out of extractor.ts
 * but left the 493-line sequencer byte-identical, so the tracker's DONE was a
 * claim about the file, not about the function).
 *
 * Order is the whole contract here, and most of it is not obvious:
 *
 *  - The worker and the node are resolved first, because every later trace
 *    names them.
 *  - `branch` is refused regardless of config; a conversation digest is
 *    refused because re-summarising an authored summary destroys it; a
 *    telegram turn is embedded but never summarised.
 *  - The two SIDE passes (auto-table, embedded images) run mid-chain, after
 *    the hard skips and before the type allowlist, because a spreadsheet
 *    should still reach /tables when `file` is not in target_types. They are
 *    best-effort and deliberately not gates.
 *  - Metadata-only runs BEFORE the key pre-flight (it needs no LLM) and
 *    BEFORE the already-extracted guard (it carries its own idempotency, and
 *    a mode flip must re-run).
 *  - Already-extracted is last, and requires the completion marker as well as
 *    summary+embedding: those are written first, so checking them alone made
 *    every retry skip a pass that had failed partway.
 *
 * Each refusal records its own `skipped` trace with a disposition, which is
 * what makes "I uploaded X and nothing happened" answerable in /traces.
 * gates.test.ts pins the order and the dispositions.
 */

import { eq, sql } from 'drizzle-orm';
import { db, nodes, contentChunks, type ExtractorParams } from '@mantle/db';
import { embed } from '@mantle/embeddings';
import { effectiveBrainDepth, resolveEffectiveIndexing, metadataSpineText } from '@mantle/files';
import { recordSkippedTrace } from '@mantle/tracing';
import { resolveChatKey } from '@mantle/runtime/agent';
import { resolveExtractor } from './model';
import { maybeAutoTableSpreadsheet } from './auto-table';
import { maybeExtractEmbeddedImages } from './images';

/** Types we will NEVER extract from, no matter what the agent config says.
 *  Note `secret` is NOT here — secret nodes have metadata-only extraction
 *  (see `readNodeBody`'s special case). The encrypted value is never
 *  loaded from the `secrets` table by this file, so it physically can't
 *  leak into a prompt. */
const HARD_SKIP_TYPES = new Set(['branch']);

/** Default allowlist; per-agent override via memory_config.extract_types.
 *  `file` covers text files (.md/.txt/.json/.yaml) read via the disk
 *  fallback in readNodeBody, plus PDFs parsed through `pdf-parse`.
 *  `email` / `email_thread` cover IMAP-ingested messages — subject +
 *  bodyText are pulled from the `emails` row.
 *  `secret` is METADATA-ONLY: only title + description + tags reach the
 *  LLM. The sealed value never leaves the DB.
 *  `task` and `event` are first-class content: title + body + metadata
 *  (status, due_at, starts_at, location, …) all become part of the body
 *  the extractor summarises and embeds. */
const DEFAULT_EXTRACT_TYPES = [
  'note',
  'page',
  'table',
  'file',
  'email',
  'email_thread',
  'secret',
  'task',
  'event',
  'contact',
  'documentation',
  'journal',
  'location',
  'formula',
  'draw',
];

/** What the sequencer needs once the gate has admitted a node. */
export type ExtractAdmission =
  | { proceed: false }
  | {
      proceed: true;
      node: typeof nodes.$inferSelect;
      worker: Awaited<ReturnType<typeof resolveExtractor>> & object;
      params: ExtractorParams;
      /** documentation collections index to L5 but skip L4 (entities, facts). */
      retrievalOnly: boolean;
      existingData: Record<string, unknown>;
    };

/**
 * Run every admission check, in order, recording a `skipped` trace for
 * whichever one refuses. `{ proceed: false }` means the caller returns without
 * spending anything; the trace already says why.
 */
export async function admitForExtraction(
  nodeId: string,
  ownerId: string,
): Promise<ExtractAdmission> {
  // Every early-return below now records a `skipped` trace so the
  // operator can see WHY the extractor declined to run this node.
  // Previously these were silent returns and "I uploaded X but
  // nothing happened" was un-debuggable. See migration 0029 +
  // recordSkippedTrace in @mantle/tracing.

  const worker = await resolveExtractor(ownerId);
  if (!worker) {
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: nodeId,
      subjectKind: 'node',
      disposition: 'no_extractor_worker',
      details: {
        hint: 'Configure an extractor at /settings/ai-workers and mark it default.',
      },
    });
    return { proceed: false };
  }

  // Load the node.
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) {
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: nodeId,
      subjectKind: 'node',
      disposition: 'node_not_found',
      details: { worker_slug: worker.slug },
    });
    return { proceed: false };
  }
  if (HARD_SKIP_TYPES.has(node.type)) {
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: nodeId,
      subjectKind: 'node',
      disposition: 'hard_skip_type',
      details: {
        node_type: node.type,
        worker_slug: worker.slug,
        hint: `Type '${node.type}' is hard-coded as skip (transient/internal kinds).`,
      },
    });
    return { proceed: false };
  }

  // Conversation digests are ALREADY summaries (authored by the
  // summarizer into data.summary, with no data.content). Re-running the
  // extractor on them re-summarises from the *title* and overwrites
  // data.summary with a useless paraphrase — destroying the real digest
  // and corrupting Layer-3 memory (the responder reads data.summary).
  // Never extract them.
  const digestData = (node.data ?? {}) as Record<string, unknown>;
  const isConversationDigest =
    node.type === 'note' &&
    ((node.tags ?? []).includes('conversation-digest') ||
      digestData.kind === 'conversation_digest');
  if (isConversationDigest) {
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      disposition: 'conversation_digest',
      details: {
        node_type: node.type,
        worker_slug: worker.slug,
        hint: 'Conversation digests are authored summaries — the extractor must not re-summarise them.',
      },
    });
    return { proceed: false };
  }

  // Telegram turns: EMBED-ONLY. Short conversational lines are worth making
  // semantically searchable (search_nodes, Remy recall) but not worth an LLM
  // summary/fact pass each — which is why they're deliberately absent from
  // extract_types. Embeddings are local + cached, so this is ~free. Closes the
  // architecture §16 "telegram messages aren't embedded" gap.
  if (node.type === 'telegram_message') {
    const tgData = (node.data ?? {}) as Record<string, unknown>;
    const tgText = typeof tgData.text === 'string' ? tgData.text.trim() : '';
    let embedded = false;
    if (tgText.length >= 2 && !node.embedding) {
      try {
        const vec = await embed(ownerId, tgText.slice(0, 2000));
        await db.update(nodes).set({ embedding: vec }).where(eq(nodes.id, node.id));
        embedded = true;
      } catch (err) {
        console.error(
          '[extractor] telegram embed failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      disposition: 'telegram_embed_only',
      details: {
        node_type: node.type,
        worker_slug: worker.slug,
        embedded,
        hint: 'Telegram turns get an embedding for search but no summary/fact extraction.',
      },
    });
    return { proceed: false };
  }

  // Auto-table a spreadsheet upload into typed Table(s), independent of the
  // text-extraction allowlist below (registers should reach /tables even if
  // 'file' isn't in target_types). Best-effort: never let it block or fail the
  // text-extraction pass. Deduped + published inside the helper.
  await maybeAutoTableSpreadsheet(node, ownerId).catch((err) => {
    // Flagged fatal (DWG sidecar failure): every pass depends on that same
    // exchange, so let the whole extract fail and retry rather than complete
    // a node that silently lost its registry workbook.
    if ((err as { fatalToExtract?: boolean })?.fatalToExtract) throw err;
    console.error('[extractor] auto-table failed:', err instanceof Error ? err.message : err);
  });

  // target_types is the new home for the type allowlist. We still
  // accept extract_types for legacy backfilled rows in the same
  // params blob — extractTypes prefers the new name.
  const params = (worker.params ?? {}) as ExtractorParams;
  const extractTypes = params.target_types ?? params.extract_types ?? DEFAULT_EXTRACT_TYPES;

  // Pull embedded diagrams/screenshots out into their own image files, on the
  // same terms: independent of the text allowlist, best-effort, never fatal.
  // Read AFTER params so the per-document image cap is configurable.
  await maybeExtractEmbeddedImages(node, ownerId, params.max_embedded_images_per_doc).catch((err) =>
    console.error('[extractor] embedded images failed:', err instanceof Error ? err.message : err),
  );

  // Brain depth: documentation collections default to 'retrieval' — index to
  // L5 (summary + embedding + chunks) but SKIP L4 (entity reconciliation,
  // relations, facts) so system-meta ("Mantle uses HNSW") never lands in the
  // personal profile + graph. Every other type is always 'full'. The depth is
  // stamped on the node from doc_collections.brain_depth at sync time.
  const brainDepth = effectiveBrainDepth(
    node.type,
    (node.data as Record<string, unknown> | null)?.brain_depth,
  );
  const retrievalOnly = brainDepth === 'retrieval';
  // `*` is a wildcard meaning "any non-HARD_SKIP type" — already enforced above.
  if (!extractTypes.includes('*') && !extractTypes.includes(node.type)) {
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      disposition: 'type_not_in_allowlist',
      details: {
        node_type: node.type,
        allowed_types: extractTypes,
        worker_slug: worker.slug,
        hint: `Add '${node.type}' (or '*') to the worker's target_types param to extract it.`,
      },
    });
    return { proceed: false };
  }

  // Metadata-only files: the owner (or an ancestor folder's flag) asked for
  // this file's CONTENT to stay out of the brain. Runs BEFORE the key
  // pre-flight because it needs no LLM: the spine is deterministic text and
  // the embedding is local. It also runs before the already_extracted guard,
  // carrying its own idempotency (data.indexing_applied) — the guard's
  // summary+embedding+marker check can't distinguish which MODE produced
  // them, and a mode flip must re-run.
  if (node.type === 'file') {
    const { effective, source, sourcePath } = await resolveEffectiveIndexing(ownerId, node);
    if (effective === 'metadata') {
      const mdData = (node.data ?? {}) as Record<string, unknown>;
      const alreadyMetadata =
        mdData.indexing_applied === 'metadata' &&
        typeof mdData.summary === 'string' &&
        node.embedding &&
        mdData.extract_completed_at;
      if (alreadyMetadata) {
        await recordSkippedTrace({
          kind: 'extractor_run',
          ownerId,
          subjectId: node.id,
          subjectKind: 'node',
          disposition: 'metadata_only_current',
          details: { worker_slug: worker.slug, node_type: node.type, title: node.title },
        });
        return { proceed: false };
      }
      const spine = metadataSpineText(node);
      let vec: number[] | null = null;
      try {
        vec = await embed(ownerId, spine);
      } catch (err) {
        // No embedding this pass — keep going. The summary + FTS still index
        // the spine; the completion marker is withheld below so the next
        // notify retries the vector once the embedder is back.
        console.error(
          '[extractor] metadata-only embed failed:',
          err instanceof Error ? err.message : err,
        );
      }
      await db.transaction(async (tx) => {
        // Reap content chunks — on a full→metadata flip they are exactly the
        // content the owner just un-indexed, and search would keep serving
        // them. A fresh upload has none; the delete is a no-op there.
        await tx.delete(contentChunks).where(eq(contentChunks.nodeId, node.id));
        // Strip the content CACHES too (`- 'text' - 'content'`), not just the
        // chunks: `search_tsv` is a generated column over the whole data blob,
        // so extracted text left in `data` keeps matching keyword search —
        // exactly the leak this mode promises not to have (2026-08-22 audit).
        // Disk keeps the bytes; a flip back to full re-reads from there
        // (readNodeBodyRaw's documented fallback), so nothing is lost.
        await tx
          .update(nodes)
          .set({
            data: sql`(${nodes.data} - 'text' - 'content') || ${JSON.stringify({
              summary: spine,
              summary_model: 'metadata-only',
              indexing_applied: 'metadata',
              ...(vec ? { extract_completed_at: new Date().toISOString() } : {}),
            })}::jsonb`,
            ...(vec ? { embedding: vec } : {}),
          })
          .where(eq(nodes.id, node.id));
      });
      await recordSkippedTrace({
        kind: 'extractor_run',
        ownerId,
        subjectId: node.id,
        subjectKind: 'node',
        disposition: 'metadata_only_indexed',
        details: {
          worker_slug: worker.slug,
          node_type: node.type,
          title: node.title,
          indexing_source: source,
          ...(sourcePath ? { inherited_from: sourcePath } : {}),
          embedded: Boolean(vec),
          hint: 'Content deliberately not read — indexed by name/type/tags only (data.indexing).',
        },
      });
      return { proceed: false };
    }
    // Falling through to a FULL pass: stamp which mode this run applies so a
    // later metadata flip knows there is content to reap. Stamped here (not in
    // update_index) to anchor the contract next to its counterpart above.
    // Harmless duplicate writes are avoided by only writing on change.
    const fullData = (node.data ?? {}) as Record<string, unknown>;
    if (fullData.indexing_applied !== 'full') {
      await db
        .update(nodes)
        .set({ data: sql`${nodes.data} || '{"indexing_applied":"full"}'::jsonb` })
        .where(eq(nodes.id, node.id));
    }
  }

  // Key pre-flight via the shared resolver — keyless `local` passes, a
  // misconfigured cloud worker skips with the matching trace disposition. The
  // chat call resolves the key the same way (resolveChatKey is the single
  // source of truth), so this only guards/traces; it doesn't feed the call.
  const keyCheck = await resolveChatKey(ownerId, worker);
  if (!keyCheck.ok) {
    console.error(`[extractor] worker '${worker.slug}' ${keyCheck.detail} — skipping`);
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      disposition: keyCheck.disposition,
      details: { worker_slug: worker.slug, node_type: node.type, api_key_id: worker.apiKeyId },
    });
    return { proceed: false };
  }

  // Skip only when a PRIOR RUN FULLY COMPLETED: summary + embedding present
  // AND the extract_completed_at marker (stamped as the final step of a
  // successful pass). Guarding on summary+embedding alone was the
  // retry-idempotency hole: those are written FIRST (update_index), so any
  // failure in the later steps (chunks, entities, relations, facts) made
  // every pg-boss retry skip here — the node stayed chunk-less/fact-less
  // forever, invisibly. Legacy nodes that predate the marker re-extract
  // once on their next notify (edits clear summary anyway, so in practice
  // this only costs a stray duplicate notify on an old node) and get
  // stamped.
  const existingData = (node.data ?? {}) as Record<string, unknown>;
  if (existingData.summary && node.embedding && existingData.extract_completed_at) {
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      disposition: 'already_extracted',
      details: {
        worker_slug: worker.slug,
        node_type: node.type,
        title: node.title,
        existing_summary_chars:
          typeof existingData.summary === 'string' ? existingData.summary.length : null,
        has_embedding: true,
      },
    });
    return { proceed: false };
  }
  return { proceed: true, node, worker, params, retrievalOnly, existingData };
}
