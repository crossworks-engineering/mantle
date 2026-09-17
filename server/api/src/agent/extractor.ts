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
import { db, bumpWorkerUsage, nodes } from '@mantle/db';
import { recordSkippedTrace, startTrace } from '@mantle/tracing';
import { resolveChatRoutes } from '@mantle/runtime/agent';
import { getChatAdapter } from '@mantle/voice';
import { TEXT_STORE_MAX_CHARS, truncateForPrompt } from './extract/text';
import { runExtractorModel } from './extract/model';
import { admitForExtraction } from './extract/gates';
import { loadExtractableBody } from './extract/load-body';
import {
  buildTableIndexPieces,
  writeContentIndex,
  writeRetrievalChunks,
} from './extract/index-writes';
import { supersedeFileVersions } from './extract/supersede';
import { processRelations, reconcileEntities } from './extract/entities';
import { processFacts } from './extract/facts';

export async function extractNode(nodeId: string, ownerId: string): Promise<void> {
  // Everything that decides WHETHER to run — worker + node resolution, the
  // hard skips, the two best-effort side passes, the type allowlist, the
  // metadata-only path, the key pre-flight and the already-extracted guard —
  // lives in ./extract/gates. Order matters there and is documented there;
  // each refusal records its own `skipped` trace, so a `false` here needs no
  // further explanation.
  const admission = await admitForExtraction(nodeId, ownerId);
  if (!admission.proceed) return;
  const { node, worker, params, retrievalOnly, existingData } = admission;

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
