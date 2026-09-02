/**
 * The extractor — Stage-C agent that populates content_index, facts, and
 * entities from each new content_store row.
 *
 * Triggered by pg_notify('node_ingested') from migration 0018. Per node:
 *
 *   1. Resolve the active extractor agent. Skip if none enabled.
 *   2. Skip if node type isn't in agent.memory_config.extract_types.
 *      Defence in depth: HARD_SKIP_TYPES (secret, branch) are skipped
 *      regardless of config — secrets must NEVER be summarised or fact-
 *      extracted, period.
 *   3. Read the source body (typed dispatch by node type).
 *   4. content_index pass — generate 1-2 sentence summary + embedding.
 *      Write to nodes.data.summary, nodes.data.summary_model,
 *      nodes.data.entities, and nodes.embedding.
 *   5. Fact extraction pass (if memory_config.extract_facts !== false):
 *      a. LLM call → JSON array of candidate facts (with entity mentions).
 *      b. For each candidate fact:
 *           - Embed it.
 *           - Vector-search top-3 near-existing facts.
 *           - Classifier LLM call returns ADD | UPDATE | DELETE | NOOP.
 *           - Apply: INSERT new, supersede an existing row, retire an
 *             old fact, or no-op.
 *      c. Entity reconciliation: dedup via trigram name match +
 *         embedding similarity; create new entities for misses;
 *         add 'mentioned_in' edge from entity to source node.
 *   6. Bump agent's last_used_at + usage_count.
 *
 * Stays pure-logic — no listener registration here. main.ts wires the
 * pg_notify channel to extractNode().
 */

import { eq, sql } from 'drizzle-orm';
import { db, bumpWorkerUsage, nodes, contentChunks, type ExtractorParams } from '@mantle/db';
import { embed } from '@mantle/embeddings';
import { effectiveBrainDepth, resolveEffectiveIndexing, metadataSpineText } from '@mantle/files';
import { recordSkippedTrace, startTrace } from '@mantle/tracing';
import { resolveChatKey, resolveChatRoutes } from '@mantle/runtime/agent';
import { getChatAdapter } from '@mantle/voice';
import { TEXT_STORE_MAX_CHARS, truncateForPrompt } from './extract/text';
import { resolveExtractor, runExtractorModel } from './extract/model';
import { maybeAutoTableSpreadsheet } from './extract/auto-table';
import { maybeExtractEmbeddedImages } from './extract/images';
import { loadExtractableBody } from './extract/load-body';
import {
  buildTableIndexPieces,
  writeContentIndex,
  writeRetrievalChunks,
} from './extract/index-writes';
import { supersedeFileVersions } from './extract/supersede';
import { processRelations, reconcileEntities } from './extract/entities';
import { processFacts } from './extract/facts';

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

export async function extractNode(nodeId: string, ownerId: string): Promise<void> {
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
    return;
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
    return;
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
    return;
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
    return;
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
    return;
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
    return;
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
        return;
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
      return;
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
    return;
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
    return;
  }

  // Load the FULL extracted text — image vision, typed body dispatch, and the
  // PDF OCR / native / encrypted / bytes-missing / no-text-layer ladder all
  // live in loadExtractableBody, which records its own terminal skip traces and
  // returns { ok: false } when the node can't be indexed. `body` (truncated) is
  // what the LLM sees; `rawBody` is what we persist so the doc stays retrievable.
  const bodyResult = await loadExtractableBody(node, ownerId, worker, existingData);
  if (!bodyResult.ok) return;
  const rawBody = bodyResult.rawBody;
  const body = truncateForPrompt(rawBody);

  // Persist the full text for binary file nodes (pdf/docx/xlsx) — their
  // body lives nowhere else (text files cache it in data.content; emails
  // keep it in the emails table). Without this, only the summary survives
  // and "write out the full document" is impossible. node_read / file_read
  // return data.text so the assistant can reproduce the content on demand.
  const persistedText =
    node.type === 'file' && !existingData.content
      ? rawBody.slice(0, TEXT_STORE_MAX_CHARS)
      : undefined;

  // Resolve the chat adapter for this worker's provider. Phase-3
  // change: was `new OpenRouter({apiKey})` regardless of what the
  // worker said. Now the worker.provider field actually steers the
  // dispatch. If no adapter is wired for the provider, surface a
  // clear skipped trace rather than crashing — operators see what's
  // missing in /traces.
  const adapter = getChatAdapter(worker.provider);
  if (!adapter) {
    console.error(
      `[extractor] no chat adapter registered for provider '${worker.provider}' — skipping`,
    );
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      disposition: 'unwired_provider',
      details: {
        worker_slug: worker.slug,
        provider: worker.provider,
        model: worker.model,
        hint: `Register a chat adapter for '${worker.provider}' in packages/voice/src/adapters/index.ts, or switch the worker to a wired provider.`,
      },
    });
    return;
  }

  const routes = resolveChatRoutes(worker);
  console.log(
    `[extractor] node ${node.id.slice(0, 8)} (${node.type}, ${node.title.slice(0, 40)}) via ${adapter.adapterName}:${worker.model}` +
      (routes.backup ? ` (backup ${routes.backup.provider}:${routes.backup.model})` : ''),
  );

  // Optimistic-concurrency token for the edit-during-extract race. xmin
  // changes on EVERY update of the row, so the conditional update_index
  // below detects "something wrote to this node while the LLM was
  // summarizing" — most importantly a user edit, whose summary/embedding
  // invalidation must not be overwritten with this run's now-stale output
  // (the edit's own re-extract job would then skip on the already_extracted
  // guard, leaving stale memory durably). Captured HERE, after the
  // vision/OCR passes above persisted their own data.text writes, so only
  // foreign writes during the LLM window trip it.
  const verRows = await db.execute(sql`select xmin::text as v from ${nodes} where id = ${node.id}`);
  const rowVersion = (verRows as unknown as Array<{ v?: string }>)[0]?.v ?? null;

  await startTrace(
    {
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      // NOTE: deliberately no agentId. The trace_kind extractor_run
      // belongs to an ai_worker, but traces.agent_id is FK-constrained
      // to the `agents` table (legacy from the era when extractor was
      // an agent). Passing worker.id silently FK-violated the insert
      // and every trace vanished. worker_slug + worker_id below carry
      // the navigation handle we want.
      data: {
        nodeType: node.type,
        title: node.title,
        model: worker.model,
        provider: worker.provider,
        worker_slug: worker.slug,
        worker_id: worker.id,
      },
    },
    async () => {
      const parsed = await runExtractorModel(
        node,
        ownerId,
        worker,
        routes,
        params,
        body,
        existingData,
      );

      // ─── content_index pass ───────────────────────────────────────────
      const summary = parsed.summary;

      const { tableProfilePieces, tableSchemaDigest } = await buildTableIndexPieces(node, summary);

      const allEntityMentions = [
        ...parsed.entities,
        ...parsed.facts.flatMap((f) => f.entities ?? []),
      ];
      const seenNames = new Set<string>();
      const uniqueMentions = allEntityMentions.filter((m) => {
        const key = m.name.trim().toLowerCase();
        if (seenNames.has(key)) return false;
        seenNames.add(key);
        return true;
      });

      await writeContentIndex(
        node,
        ownerId,
        worker,
        summary,
        uniqueMentions,
        persistedText,
        tableSchemaDigest,
        rowVersion,
      );

      // ─── chunked retrieval index ─────────────────────────────────────
      await writeRetrievalChunks(node, ownerId, rawBody, tableProfilePieces);

      // ─── versioned-export supersede (file nodes) ─────────────────────
      if (node.type === 'file') {
        await supersedeFileVersions(node, ownerId);
      }

      // ─── entity reconciliation ───────────────────────────────────────
      // Retrieval-only docs skip this entirely: no entity rows, no
      // `mentioned_in` edges — L4 stays empty for them.
      const entityIdByName = retrievalOnly
        ? new Map<string, string>()
        : await reconcileEntities(node, ownerId, uniqueMentions);

      // ─── relation pass (entity↔entity edges → knowledge graph) ───────
      // Runs whenever the deep-extraction tier is on, independent of whether
      // any facts were found — a document can establish relationships
      // ("Sarah works_at Lister") without a fact worth storing. Edges stamp
      // source_node_id + confidence so a relation is citable + auditable, and
      // are rebuilt-keyed-by-node: delete this node's prior relation edges
      // (the only edges that carry source_node_id) then re-insert, so a
      // re-extract REPLACES rather than appends — and a doc that no longer
      // yields a relation has its stale edge cleared.
      if (params.extract_facts !== false && !retrievalOnly) {
        await processRelations(node, ownerId, parsed, entityIdByName);
      }

      // ─── fact extraction pass ────────────────────────────────────────
      // Retrieval-only docs never persist facts (L4 skip).
      if (params.extract_facts === false || retrievalOnly || parsed.facts.length === 0) {
        await stampExtractCompleted(node.id);
        void bumpWorkerUsage(worker.id);
        return;
      }

      const tally = await processFacts(node, ownerId, worker, params, parsed, entityIdByName);

      console.log(
        `[extractor]   → facts: ADD=${tally.ADD} UPDATE=${tally.UPDATE} DELETE=${tally.DELETE} NOOP=${tally.NOOP} retired=${tally.retired}`,
      );

      await stampExtractCompleted(node.id);
      void bumpWorkerUsage(worker.id);
    },
  );
}

/** Final step of a fully-successful extraction pass. The already_extracted
 *  skip guard requires this marker IN ADDITION to summary+embedding, so a
 *  pg-boss retry after a partial failure (chunks/entities/relations/facts)
 *  re-runs instead of skipping. A cost-cap-truncated fact pass still stamps
 *  (matching the pre-marker skip semantics) — `data.extract_incomplete` is
 *  the recovery signal for that case. Deliberately a plain jsonb merge with
 *  no version condition: a user edit clears summary/embedding, and the guard
 *  is a conjunction, so a stale stamp can never suppress the edit's
 *  re-extract. */
async function stampExtractCompleted(nodeId: string): Promise<void> {
  await db
    .update(nodes)
    .set({
      data: sql`${nodes.data} || ${JSON.stringify({ extract_completed_at: new Date().toISOString() })}::jsonb`,
    })
    .where(eq(nodes.id, nodeId));
}

// bumpAgentUsage was removed when the extractor moved to ai_workers.
// Use bumpWorkerUsage from @mantle/db instead.

// Public surface kept where it always was: the queue imports extractNode, the
// chat test and tracing import chatComplete / the prompt from './extractor'.
export { chatComplete } from './extract/model';
export { DEFAULT_EXTRACTOR_PROMPT } from './extract/prompts';
