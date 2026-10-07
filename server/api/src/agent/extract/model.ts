/**
 * Extractor: Resolving the extractor worker and calling the model (summary + facts, classifier).
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { getDefaultWorker, nodes, type AiWorker, type ExtractorParams } from '@mantle/db';
import { step } from '@mantle/tracing';
import {
  chatWithFailover,
  recordChatUsage,
  resolveChatRoutes,
  type ChatRoutes,
} from '@mantle/runtime/agent';
import { type ChatResult } from '@mantle/voice';
import { noteProviderFailure, noteProviderSuccess, tagProviderSubject } from '@mantle/embeddings';
import { parseExtractorOutput, type ExtractorOutput } from '../extractor-parse';
import { DEFAULT_EXTRACTOR_PROMPT } from './prompts';

export async function resolveExtractor(ownerId: string): Promise<AiWorker | null> {
  return await getDefaultWorker(ownerId, 'extractor');
}

/**
 * Single-turn chat completion through the adapter registry.
 *
 * Phase-3 shape: the extractor used to construct `new OpenRouter()`
 * directly and call `client.chat.send` regardless of what the worker
 * said. Now it resolves the chat adapter for `worker.provider` and
 * goes through `adapter.chat()` — so a worker configured for direct
 * Anthropic / direct Google / xAI / HF actually routes there instead
 * of falling through to OpenRouter.
 *
 * Returns the typed ChatResult so the call site can pass it straight
 * to `recordChatUsage` without scraping a raw response.
 */
export async function chatComplete(
  ownerId: string,
  routes: ChatRoutes,
  systemPrompt: string,
  userText: string,
  params: ExtractorParams,
): Promise<ChatResult> {
  const { result, failedOver, usedProvider } = await chatWithFailover(
    ownerId,
    routes,
    {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
      // The extractor's system prompt is identical across every node
      // ingest (modulo per-worker customisation, which is also static
      // per worker). Mark it cacheable — Anthropic-direct workers get
      // ~10× cheaper input on the second+ call within the 5-min TTL;
      // non-cache-aware providers (Google, xAI, HF) ignore the field.
      // During a backfill or active ingest hour this is the dominant
      // cost-saving knob.
      cacheControl: { systemPrompt: true },
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      ...(typeof params.max_tokens === 'number' ? { maxTokens: params.max_tokens } : {}),
      ...(typeof params.top_p === 'number' ? { topP: params.top_p } : {}),
    },
    (m) => console.warn(`[extractor] ${m}`),
  ).catch((err: unknown) => {
    // The provider-alert store (docs/embeddings.md "Provider outages"): an
    // account or outage error is recorded for admins, and tagged so the
    // extract queue's circuit knows it came from the extraction model.
    tagProviderSubject(err, 'extraction', routes.primary.provider);
    noteProviderFailure(ownerId, 'extraction', err, {
      provider: routes.primary.provider,
      model: routes.primary.model,
    });
    throw err;
  });
  noteProviderSuccess(ownerId, 'extraction');
  if (failedOver) console.warn(`[extractor] completed via backup route (${usedProvider})`);
  return result;
}

/**
 * The outage probe for the extraction model (server/api provider-circuit.ts):
 * ONE tiny chat call through the extractor worker's routes (primary, then the
 * backup on failover). A few tokens. Throws the provider's error on failure;
 * a success closes the extraction alert. No extractor worker = nothing to
 * probe, which counts as working (extraction skips with its own trace).
 */
export async function probeExtractionModel(ownerId: string): Promise<void> {
  const worker = await resolveExtractor(ownerId);
  if (!worker) return;
  await chatComplete(
    ownerId,
    resolveChatRoutes(worker),
    'You are a health check.',
    'Reply with the word OK.',
    { max_tokens: 16 },
  );
}

// ─── Entity reconciliation ──────────────────────────────────────────────────

/**
 * Run the extractor LLM over the node body and return the parsed output
 * (summary + facts + entities + relations). Two paths: a shape-unchanged table
 * REUSES its committed summary (no LLM spend), everything else calls the model.
 * Wraps the same `reuse_summary` / `llm_extract` trace steps as before.
 */
export async function runExtractorModel(
  node: typeof nodes.$inferSelect,
  ownerId: string,
  worker: AiWorker,
  routes: ChatRoutes,
  params: ExtractorParams,
  body: string,
  existingData: Record<string, unknown>,
): Promise<ExtractorOutput> {
  const systemPrompt = worker.systemPrompt || DEFAULT_EXTRACTOR_PROMPT;
  // Tables get a targeted L2 brief: the body is already profile + leading
  // rows (built at commit), so steer the summary toward what the table
  // contains, per-column meaning, and the questions it can answer.
  const tableHint =
    node.type === 'table'
      ? 'This is a structured data table (its column profile and leading rows follow). Describe what the table contains, what each column means, and what questions it can answer.\n\n'
      : '';
  const userPayload = `Title: ${node.title}\nType: ${node.type}\n\n${tableHint}Body:\n${body.slice(0, 8000)}`;

  // Shape-hash gate (Tables v2 §6): commitTable KEEPS data.summary when
  // only cell values changed (schema fingerprint unchanged) and clears it
  // when the shape changed. A table arriving here WITH a summary is
  // therefore a cell-edit re-index: reuse the summary, skip the LLM, and
  // refresh only the deterministic layers (profile chunks + embedding).
  const reusedTableSummary =
    node.type === 'table' &&
    typeof existingData.summary === 'string' &&
    existingData.summary.trim().length > 0
      ? existingData.summary
      : null;

  const parsed = reusedTableSummary
    ? await step(
        {
          name: 'reuse_summary',
          kind: 'compute',
          input: {
            reason: 'table shape unchanged — commit kept the summary; LLM pass skipped',
          },
        },
        async (h) => {
          const entities = (Array.isArray(existingData.entities) ? existingData.entities : [])
            .filter((n): n is string => typeof n === 'string')
            .map((name) => ({ name, kind: 'unknown' }));
          h.setOutput({ summary_chars: reusedTableSummary.length, entities: entities.length });
          return {
            summary: reusedTableSummary,
            facts: [],
            entities,
            relations: [],
            reused: true,
          } as ReturnType<typeof parseExtractorOutput>;
        },
      )
    : await step(
        {
          name: 'llm_extract',
          kind: 'llm_call',
          input: {
            model: worker.model,
            provider: worker.provider,
            // Surface everything the LLM saw. No per-field char caps —
            // the global truncateJson budget (64KB) catches truly
            // runaway bodies and the node itself lives in /files for
            // larger reads. Operators want the full preview when
            // debugging "what did the extractor actually read?".
            title: node.title,
            node_type: node.type,
            body_chars: body.length,
            body_preview: body,
          },
        },
        async (h) => {
          const r = await chatComplete(ownerId, routes, systemPrompt, userPayload, params);
          recordChatUsage(h, r, r.model || worker.model);
          const result = parseExtractorOutput(r.text, { nodeId: node.id, model: worker.model });
          // Capture the full model output — summary, all entities,
          // all facts. truncateJson at the tracing layer will only
          // bite if the combined JSON exceeds 64KB, which is
          // generous for normal extractor outputs.
          h.setOutput({
            summary: result.summary,
            entity_count: result.entities.length,
            entities: result.entities.map((e) => ({
              name: e.name,
              kind: e.kind ?? 'unknown',
            })),
            fact_count: result.facts.length,
            facts: result.facts.map((f) => f.content),
          });
          return result;
        },
      );
  return parsed;
}
