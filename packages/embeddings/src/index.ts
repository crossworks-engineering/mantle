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
import { getApiKey, getApiKeyById } from '@mantle/api-keys';
import { currentTrace, step } from '@mantle/tracing';
// `@mantle/voice` self-registers all built-in adapters on import. The
// embedding ones (openrouter / openai / google / mistral / cohere) come
// online as a side effect of touching this module. Don't tree-shake.
import { getEmbeddingAdapter, type EmbedInput } from '@mantle/voice';

export type { EmbedInput };
export { runReembed, type ReembedOpts, type ReembedResult, type ReembedProgressEvent } from './reembed';

/** Models that accept non-text inputs. Kept here for callers (the
 *  extractor's attachment path) that need to know in advance which
 *  models to route through for image/audio/file embedding. The
 *  authoritative `acceptsInput` lives on each adapter — this set is
 *  the cross-provider summary. */
export const MULTIMODAL_MODELS = new Set<string>([
  'google/gemini-embedding-2-preview',
  'nvidia/llama-nemotron-embed-vl-1b-v2',
  'nvidia/llama-nemotron-embed-vl-1b-v2:free',
]);

export function isMultimodalModel(model: string): boolean {
  return MULTIMODAL_MODELS.has(model.toLowerCase());
}

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
export const EMBEDDING_DIMS = 768;

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

/** Worker-derived config the runtime uses for one embedding call. */
export interface EmbeddingConfig {
  /** Model slug. For OpenRouter this is `provider/model-name`; for direct
   *  providers it's the bare id (e.g. `text-embedding-3-small`). */
  model: string;
  /** Provider id matching `ai_workers.provider`. Drives adapter dispatch. */
  provider: string;
  /** When set, the worker pinned a specific API key — `getApiKeyById`
   *  resolves it. Null = fall through to `getApiKey(ownerId, provider)`. */
  apiKeyId: string | null;
}

const _resolverCache = new Map<string, { config: EmbeddingConfig; expiresAt: number }>();

/**
 * Return the full embedding worker config (model + provider + apiKeyId)
 * for this owner. Resolution order:
 *   1. `ai_workers` row with `kind='embedding'`, `enabled=true`, the
 *      default-flagged or highest-priority match — use its model,
 *      provider, and apiKeyId.
 *   2. No worker → default provider `openrouter`, model from
 *      `MANTLE_EMBEDDING_MODEL` env var (or hardcoded fallback),
 *      apiKeyId null (caller falls back to `getApiKey(ownerId, 'openrouter')`).
 *
 * Cached per ownerId for 60s. Mutations on `/settings/ai-workers` call
 * {@link clearEmbeddingModelCache} so a model swap kicks in immediately.
 */
export async function resolveEmbeddingConfig(ownerId: string): Promise<EmbeddingConfig> {
  const cached = _resolverCache.get(ownerId);
  if (cached && cached.expiresAt > Date.now()) return cached.config;
  let config: EmbeddingConfig = {
    model: DEFAULT_EMBEDDING_MODEL,
    provider: 'openrouter',
    apiKeyId: null,
  };
  try {
    const worker = await getDefaultWorker(ownerId, 'embedding');
    if (worker?.model && worker.provider) {
      config = {
        model: worker.model,
        provider: worker.provider,
        apiKeyId: worker.apiKeyId ?? null,
      };
    }
  } catch (err) {
    // DB unreachable? Fall back gracefully — embedding still works against
    // whatever the env / hardcoded default points at. Log so operators can
    // notice if it's a persistent state.
    console.warn(
      '[embeddings] resolveEmbeddingConfig: DB lookup failed, using fallback —',
      err instanceof Error ? err.message : err,
    );
  }
  _resolverCache.set(ownerId, { config, expiresAt: Date.now() + RESOLVER_TTL_MS });
  return config;
}

/**
 * Backward-compat thin wrapper. Returns just the model slug — keeps the
 * pre-adapter resolver shape so callers that only need the model id
 * (the reembed CLI script's logging, the trace's `input.model` field)
 * don't have to destructure.
 */
export async function resolveEmbeddingModel(ownerId: string): Promise<string> {
  const config = await resolveEmbeddingConfig(ownerId);
  return config.model;
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
  opts?: { model?: string; provider?: string; apiKeyId?: string | null },
): Promise<number[][]> {
  // Resolve once up front so the trace step opens with the actual model
  // and doEmbed doesn't have to re-resolve. Explicit `opts.model` (and
  // optional provider/apiKeyId) win over the resolver, preserving the
  // per-call escape hatch the extractor's override path uses.
  const baseConfig = await resolveEmbeddingConfig(ownerId);
  const config: EmbeddingConfig = {
    model: opts?.model ?? baseConfig.model,
    provider: opts?.provider ?? baseConfig.provider,
    apiKeyId: opts?.apiKeyId !== undefined ? opts.apiKeyId : baseConfig.apiKeyId,
  };
  // No trace → fast path with no instrumentation overhead.
  if (!currentTrace()) {
    return doEmbed(ownerId, inputs, config);
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
        model: config.model,
        provider: config.provider,
        preview: inputs.map(previewOfInput),
      },
    },
    async (handle) => doEmbed(ownerId, inputs, config, handle),
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
  config: EmbeddingConfig,
  stepHandle?: EmbedStepHandle,
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const { model, provider } = config;

  // 0. Resolve adapter. Surface a clear error rather than silently
  //    routing through OR if the provider isn't wired.
  const adapter = getEmbeddingAdapter(provider);
  if (!adapter) {
    throw new Error(
      `embed: no adapter registered for provider '${provider}'. The embedding ` +
        `worker config points at an unknown provider — pick one of ` +
        `openrouter / openai / google / mistral / cohere at /settings/ai-workers.`,
    );
  }

  // 1. Validate: every input must be accepted by the adapter. Text-only
  //    providers (every direct provider) reject image/audio/file inputs
  //    up front so the caller gets a clear error before the API call.
  if (adapter.acceptsInput) {
    for (const item of inputs) {
      if (!adapter.acceptsInput(item)) {
        const itemType = typeof item === 'string' ? 'text' : item.type;
        throw new Error(
          `embed: input type '${itemType}' not accepted by adapter '${adapter.adapterName}' ` +
            `(model='${model}'). Multimodal inputs require the OpenRouter provider with ` +
            `a multimodal model (e.g. google/gemini-embedding-2-preview).`,
        );
      }
    }
  }

  // 2. Cache lookup, keyed by (model, content). Two providers serving the
  //    same model would share cache entries — fine, same underlying model
  //    means same vectors. Different slugs (OR's 'openai/text-embedding-3-small'
  //    vs OpenAI direct's 'text-embedding-3-small') cache separately, which
  //    is also fine — they produce identical vectors but go through different
  //    keys.
  const hashes = inputs.map((i) => hashKey(model, i));
  const out: (number[] | null)[] = inputs.map(() => null);
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

  // 3. Compute misses.
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
    // Resolve the api key. Worker-pinned id wins; fall back to the
    // provider's canonical service slug. The fallback covers two cases:
    // (a) no embedding worker configured at all (config.apiKeyId is null,
    // provider stays 'openrouter'), (b) worker exists but its apiKeyId
    // was nulled (key deleted out from under it).
    let apiKey: string | null = null;
    if (config.apiKeyId) {
      apiKey = await getApiKeyById(config.apiKeyId);
    }
    if (!apiKey) {
      apiKey = await getApiKey(ownerId, provider);
    }
    if (!apiKey) {
      // The `local` provider points at a self-hosted OpenAI-compatible server
      // (Ollama / LM Studio / llama.cpp) on your own hardware — no credential
      // needed. The adapter sends a placeholder Bearer the server ignores, so
      // don't demand a key here.
      if (provider === 'local') {
        apiKey = 'local';
      } else {
        throw new Error(
          `embed: no api key for provider '${provider}'. Add one at /settings/keys ` +
            `and assign it to your embedding worker at /settings/ai-workers/embedding.`,
        );
      }
    }

    for (let start = 0; start < missInputs.length; start += MAX_BATCH) {
      const slice = missInputs.slice(start, start + MAX_BATCH);
      const result = await adapter.embed({
        apiKey,
        model,
        input: slice,
        // Used by adapters that honour MRL truncation (OpenAI's text-embedding-3-*,
        // Google's gemini-embedding-*). Adapters that ignore it pass through
        // unaffected. The brain's pgvector column is fixed at 1536 so requesting
        // 1536 across the board keeps inserts compatible.
        dimensions: EMBEDDING_DIMS,
      });
      apiCalls++;
      if (result.vectors.length !== slice.length) {
        throw new Error(
          `embed: provider returned ${result.vectors.length} vectors for ${slice.length} inputs`,
        );
      }
      const cacheRows = result.vectors.map((vec, j) => {
        const inputIdx = missIndexes[start + j]!;
        const hash = hashes[inputIdx]!;
        out[inputIdx] = vec;
        return { contentHash: hash, embedding: vec };
      });
      await db.insert(embeddingCache).values(cacheRows).onConflictDoNothing();
    }
  }

  // 4. Sanity check.
  for (let i = 0; i < out.length; i++) {
    if (!out[i] || out[i]!.length !== EMBEDDING_DIMS) {
      throw new Error(
        `embed: missing or wrong-shaped vector at index ${i} (got length=${out[i]?.length ?? 'null'}, expected ${EMBEDDING_DIMS}). ` +
          `If you just switched models, check the form's dim guard — the picked model may not emit ${EMBEDDING_DIMS}-dim vectors.`,
      );
    }
  }

  stepHandle?.setMeta({
    cache_hits: inputs.length - missInputs.length,
    cache_misses: missInputs.length,
    api_calls: apiCalls,
    model,
    provider,
  });

  return out as number[][];
}
