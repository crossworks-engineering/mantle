/**
 * Embeddings — the shared utility every memory layer leans on.
 *
 *   embed(text)              → vector(1536), cached by content hash.
 *   embedBatch(texts)        → vector(1536)[], cached per-input.
 *   embedMultimodal(inputs)  → vector(1536)[] for text / image / audio / file.
 *
 * Default backend: OpenRouter `openai/text-embedding-3-small` (1536 dims) using
 * the `openrouter` key from @mantle/api-keys. Override globally with the
 * `MANTLE_EMBEDDING_MODEL` env var, or per call with `opts.model`.
 *
 * Multimodal models (`google/gemini-embedding-2-preview`,
 * `nvidia/llama-nemotron-embed-vl-1b-v2`) accept richer inputs via
 * `embedMultimodal`. The column stays at 1536 — Gemini's `output_dimensionality`
 * is passed through so the response fits without a schema change.
 *
 * Cache lives in the `embedding_cache` table keyed by
 * sha256(model || ':' || canonical(input)), so re-embedding identical
 * strings — or identical image URLs — is a single SELECT.
 */

import { createHash } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { db, embeddingCache, getDefaultWorker } from '@mantle/db';
import { getApiKey } from '@mantle/api-keys';
import { currentTrace, step } from '@mantle/tracing';
import {
  callEmbeddings,
  isMultimodalModel,
  MULTIMODAL_MODELS,
  type EmbedInput,
} from './client';

export { MULTIMODAL_MODELS, isMultimodalModel, type EmbedInput } from './client';
export { runReembed, type ReembedOpts, type ReembedResult, type ReembedProgressEvent } from './reembed';

const FALLBACK_MODEL = 'openai/text-embedding-3-small';
/**
 * Process-level fallback when no `embedding` AI worker is configured and no
 * `MANTLE_EMBEDDING_MODEL` env override is set. Exported for the few call
 * sites (re-embed script, eager preview generation) that don't have an
 * `ownerId` in hand and so can't go through {@link resolveEmbeddingModel}.
 * Normal runtime paths should NOT read this directly — they should call
 * `resolveEmbeddingModel(ownerId)` so the operator's worker pick wins.
 */
export const DEFAULT_EMBEDDING_MODEL =
  process.env.MANTLE_EMBEDDING_MODEL?.trim() || FALLBACK_MODEL;
export const EMBEDDING_DIMS = 1536;

// ── Per-owner resolver ─────────────────────────────────────────────────────
//
// Reads from `ai_workers WHERE kind='embedding'` so the operator picks once
// at `/settings/ai-workers/embedding` and every consumer (extractor, agent
// memory, recall, MCP search, tool-result spill) sees the same model. Falls
// back to env, then the hardcoded constant — preserving status-quo behaviour
// when no worker row exists.
//
// In-process Map cache with a short TTL: the extractor embeds many texts
// per ingest, the recall builtin embeds per query, and the spill store
// embeds per `read_result query` — all hot paths that would otherwise pound
// the DB. 60s is short enough that flipping the worker in the UI takes
// effect by the time you've finished saving; long enough that a busy
// extractor batch sees a stable lookup.

const RESOLVER_TTL_MS = 60_000;
const _resolverCache = new Map<string, { model: string; expiresAt: number }>();

/**
 * Return the embedding model slug the runtime should use for this owner.
 * Resolution order:
 *   1. `ai_workers` row with `kind='embedding'`, `enabled=true`, the
 *      default-flagged or highest-priority match for this owner.
 *   2. `MANTLE_EMBEDDING_MODEL` env var.
 *   3. The hardcoded fallback (`openai/text-embedding-3-small`).
 *
 * Cached per ownerId for 60s. Tests + the workers form should call
 * {@link clearEmbeddingModelCache} after a worker write to avoid the
 * stale-window.
 */
export async function resolveEmbeddingModel(ownerId: string): Promise<string> {
  const cached = _resolverCache.get(ownerId);
  if (cached && cached.expiresAt > Date.now()) return cached.model;
  let model = DEFAULT_EMBEDDING_MODEL;
  try {
    const worker = await getDefaultWorker(ownerId, 'embedding');
    if (worker?.model) model = worker.model;
  } catch (err) {
    // DB unreachable? Fall back gracefully — embedding still works against
    // whatever the env / hardcoded default points at. Log so operators can
    // notice if it's a persistent state.
    console.warn(
      '[embeddings] resolveEmbeddingModel: DB lookup failed, using fallback —',
      err instanceof Error ? err.message : err,
    );
  }
  _resolverCache.set(ownerId, { model, expiresAt: Date.now() + RESOLVER_TTL_MS });
  return model;
}

/** Drop cached resolution(s). Pass an ownerId to invalidate one owner, or
 *  nothing to clear the whole cache (useful in tests). */
export function clearEmbeddingModelCache(ownerId?: string): void {
  if (ownerId) _resolverCache.delete(ownerId);
  else _resolverCache.clear();
}

/** OpenRouter caps batch size; 100 is well inside provider limits. */
const MAX_BATCH = 100;

/** Canonicalise an input into a stable string so the cache key is deterministic. */
function canonicalize(input: EmbedInput): string {
  if (typeof input === 'string') return `t:${input}`;
  switch (input.type) {
    case 'text':
      return `t:${input.text}`;
    case 'image':
      return `i:${input.url}`;
    case 'audio':
      return `a:${input.url}`;
    case 'file':
      return `f:${input.url}|${input.mimeType ?? ''}`;
  }
}

function hashKey(model: string, input: EmbedInput): string {
  return createHash('sha256').update(`${model}:${canonicalize(input)}`).digest('hex');
}

/**
 * Embed a single piece of text. Cache hit returns sub-ms; miss makes one
 * OpenRouter call. Throws on API errors — callers handle.
 */
export async function embed(
  ownerId: string,
  text: string,
  opts?: { model?: string },
): Promise<number[]> {
  const [vec] = await embedBatch(ownerId, [text], opts);
  if (!vec) throw new Error('embed: empty response');
  return vec;
}

/**
 * Embed multiple text strings at once. Hits the cache for each input first;
 * remaining misses go to OpenRouter in batches of MAX_BATCH. Order of the
 * returned array matches the input order.
 */
export async function embedBatch(
  ownerId: string,
  texts: string[],
  opts?: { model?: string },
): Promise<number[][]> {
  return embedMultimodal(ownerId, texts, opts);
}

/**
 * Embed mixed multimodal inputs (text / image / audio / file). When the
 * default text model is in use and all inputs are strings, this behaves
 * exactly like embedBatch. Picking a multimodal model lets you include
 * image/audio/file references — make sure the model actually supports
 * those (see MULTIMODAL_MODELS).
 */
export async function embedMultimodal(
  ownerId: string,
  inputs: EmbedInput[],
  opts?: { model?: string },
): Promise<number[][]> {
  // Resolve once up front so the trace step opens with the actual model
  // and doEmbed doesn't have to re-resolve. An explicit `opts.model` from
  // a caller (extractor's per-worker override, the re-embed script) wins
  // over the resolver, preserving the existing per-call escape hatch.
  const model = opts?.model ?? (await resolveEmbeddingModel(ownerId));
  const resolvedOpts = { model };
  // No trace → fast path with no instrumentation overhead.
  if (!currentTrace()) {
    return doEmbed(ownerId, inputs, resolvedOpts);
  }
  return step(
    {
      name: 'embed_batch',
      kind: 'embed',
      // Full preview of every input. truncateJson at the tracing
      // layer caps the whole jsonb field at 64KB (and arrays at 50
      // items) so a giant batch is still bounded — but normal
      // extractor work (1-3 inputs per batch, each <500 chars) lands
      // fully visible. Binary multimodal inputs (image / audio /
      // file) render as placeholders since the actual bytes would
      // blow past the safety cap and be useless on inspection.
      input: {
        count: inputs.length,
        model,
        preview: inputs.map(previewOfInput),
      },
    },
    async (handle) => doEmbed(ownerId, inputs, resolvedOpts, handle),
  );
}

/** Render an EmbedInput as a string for trace step previews. Text
 *  inputs are returned verbatim — truncateJson is the safety net.
 *  Image/audio/file references show as <kind: tail-of-url> because
 *  the binary bytes themselves aren't useful in a trace card and
 *  would explode past the per-field budget. */
function previewOfInput(item: EmbedInput): string {
  if (typeof item === 'string') return item;
  if (item.type === 'text') return item.text ?? '';
  if (item.type === 'image') {
    const url = (item as { url?: string }).url ?? '';
    return `<image: ${url.slice(-40)}>`;
  }
  if (item.type === 'audio') {
    const url = (item as { url?: string }).url ?? '';
    return `<audio: ${url.slice(-40)}>`;
  }
  if (item.type === 'file') {
    const url = (item as { url?: string }).url ?? '';
    return `<file: ${url.slice(-40)}>`;
  }
  return `<${(item as { type?: string }).type ?? 'unknown'}>`;
}

type EmbedStepHandle = { setMeta(m: Record<string, unknown>): void };

async function doEmbed(
  ownerId: string,
  inputs: EmbedInput[],
  opts?: { model?: string },
  stepHandle?: EmbedStepHandle,
): Promise<number[][]> {
  const model = opts?.model ?? DEFAULT_EMBEDDING_MODEL;
  if (inputs.length === 0) return [];

  // Validate: non-text inputs require a multimodal model.
  for (const item of inputs) {
    if (typeof item !== 'string' && item.type !== 'text' && !isMultimodalModel(model)) {
      throw new Error(
        `embed: input type '${item.type}' requires a multimodal model — got '${model}'. ` +
          `Set MANTLE_EMBEDDING_MODEL or opts.model to one of: ${Array.from(MULTIMODAL_MODELS).join(', ')}.`,
      );
    }
  }

  const hashes = inputs.map((i) => hashKey(model, i));
  const out: (number[] | null)[] = inputs.map(() => null);

  // 1. Lookup cache in bulk.
  const cachedRows = await db
    .select({ contentHash: embeddingCache.contentHash, embedding: embeddingCache.embedding })
    .from(embeddingCache)
    .where(inArray(embeddingCache.contentHash, hashes));
  const cacheMap = new Map<string, number[]>();
  for (const row of cachedRows) cacheMap.set(row.contentHash, row.embedding);
  for (let i = 0; i < inputs.length; i++) {
    const cached = cacheMap.get(hashes[i]!);
    if (cached) out[i] = cached;
  }

  // 2. Compute misses.
  const missIndexes: number[] = [];
  const missInputs: EmbedInput[] = [];
  for (let i = 0; i < inputs.length; i++) {
    if (out[i] === null) {
      missIndexes.push(i);
      missInputs.push(inputs[i]!);
    }
  }

  let apiCalls = 0;
  if (missInputs.length > 0) {
    const apiKey = await getApiKey(ownerId, 'openrouter');
    if (!apiKey) {
      throw new Error(
        "embed: no 'openrouter' api key for owner — add one at /settings/keys",
      );
    }

    // Call in batches of MAX_BATCH.
    for (let start = 0; start < missInputs.length; start += MAX_BATCH) {
      const slice = missInputs.slice(start, start + MAX_BATCH);
      const vectors = await callEmbeddings(apiKey, {
        model,
        input: slice,
        outputDimensionality: EMBEDDING_DIMS,
      });
      apiCalls++;
      if (vectors.length !== slice.length) {
        throw new Error(
          `embed: provider returned ${vectors.length} vectors for ${slice.length} inputs`,
        );
      }
      // Persist + slot into output.
      const cacheRows = vectors.map((vec, j) => {
        const inputIdx = missIndexes[start + j]!;
        const hash = hashes[inputIdx]!;
        out[inputIdx] = vec;
        return { contentHash: hash, embedding: vec };
      });
      // Best-effort cache write. Conflict on existing hash → ignore.
      await db.insert(embeddingCache).values(cacheRows).onConflictDoNothing();
    }
  }

  // 3. Sanity check.
  for (let i = 0; i < out.length; i++) {
    if (!out[i] || out[i]!.length !== EMBEDDING_DIMS) {
      throw new Error(`embed: missing or wrong-shaped vector at index ${i}`);
    }
  }

  stepHandle?.setMeta({
    cache_hits: inputs.length - missInputs.length,
    cache_misses: missInputs.length,
    api_calls: apiCalls,
    model,
  });

  return out as number[][];
}
