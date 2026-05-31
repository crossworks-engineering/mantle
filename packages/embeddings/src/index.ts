/**
 * Embeddings — the shared utility every memory layer leans on.
 *
 *   embed(text)              → vector(768), cached by content hash.
 *   embedBatch(texts)        → vector(768)[], cached per-input.
 *   embedMultimodal(inputs)  → vector(768)[] for text / image / audio / file.
 *
 * The embedder is the single `embedding_config` row (migration 0061), resolved
 * via {@link resolveEmbeddingConfig}: one model + one dimension + a primary
 * route and an optional same-model backup. Default backend is the `local`
 * provider — `embeddinggemma:latest` (768 dims) via Ollama, keyless. With no
 * config row the resolver falls back to that local default; the
 * `MANTLE_EMBEDDING_MODEL` env only seeds that fallback's model id. `opts.model`
 * survives for internal callers (the re-embed CLI, the dim probe) only.
 *
 * Multimodal models (`google/gemini-embedding-2-preview`,
 * `nvidia/llama-nemotron-embed-vl-1b-v2`) accept richer inputs via
 * `embedMultimodal`. The column is 768 — MRL-capable models have their
 * `output_dimensionality` / `dimensions` truncated so the response fits
 * without a schema change.
 *
 * Cache lives in the `embedding_cache` table keyed by
 * sha256(model || ':' || canonical(input)), so re-embedding identical
 * strings — or identical image URLs — is a single SELECT.
 */

import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db, embeddingCache, embeddingConfig } from '@mantle/db';
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

const FALLBACK_MODEL = 'embeddinggemma:latest';
/**
 * Process-level fallback model id when no `embedding_config` row exists and no
 * `MANTLE_EMBEDDING_MODEL` env seed is set. Exported for the few call
 * sites (re-embed script, eager preview generation) that don't have an
 * `ownerId` in hand and so can't go through {@link resolveEmbeddingModel}.
 * Normal runtime paths should NOT read this directly — they should call
 * `resolveEmbeddingModel(ownerId)` so the operator's worker pick wins.
 *
 * Points at the local 768-dim model (migration 0060): a missing worker row
 * must NOT silently fall back to a cloud 1536 model, which would crash on
 * insert against the `vector(768)` columns. Paired with the `local` provider
 * default in {@link resolveEmbeddingConfig}.
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

/** One route to the embedding model — a provider + endpoint + key. The
 *  primary and backup are two routes to the SAME model (for availability),
 *  never two different models. */
export interface EmbeddingRoute {
  /** Provider id driving adapter dispatch (e.g. `local`, `openrouter`). */
  provider: string;
  /** Per-route base URL override, or null for the adapter's own default
   *  (e.g. the `local` adapter's `MANTLE_LOCAL_EMBEDDING_URL`). */
  baseUrl: string | null;
  /** Pinned API key id — `getApiKeyById` resolves it. Null = fall through
   *  to `getApiKey(ownerId, provider)`; keyless providers (`local`) stay null. */
  apiKeyId: string | null;
  /** Operator-facing label for the failover UI ("Mac Ollama", "HF endpoint"). */
  label: string | null;
}

/**
 * The resolved embedding config — THE single source of truth (one row in
 * `embedding_config`). One model, one dimension, a primary route and an
 * optional SAME-MODEL backup route. Nothing else in the system chooses an
 * embedder; every `embed()` call resolves from here.
 */
export interface EmbeddingConfig {
  /** Model slug. For OpenRouter `provider/model-name`; for direct providers
   *  the bare id; for `local` the served id (e.g. `embeddinggemma:latest`). */
  model: string;
  /** Locked output dimension — must match the `vector(N)` columns (768). */
  dimensions: number;
  /** The route tried first. */
  primary: EmbeddingRoute;
  /** Same-model fallback route, or null when failover is disabled. */
  backup: EmbeddingRoute | null;
}

/** Used when the owner has no `embedding_config` row (fresh install, or the
 *  DB is unreachable). Local + keyless + 768 — never a cloud 1536 model that
 *  would crash on the `vector(768)` columns. */
const LOCAL_FALLBACK_CONFIG: EmbeddingConfig = {
  model: DEFAULT_EMBEDDING_MODEL,
  dimensions: EMBEDDING_DIMS,
  primary: { provider: 'local', baseUrl: null, apiKeyId: null, label: 'Local' },
  backup: null,
};

const _resolverCache = new Map<string, { config: EmbeddingConfig; expiresAt: number }>();

/**
 * Return the single embedding config for this owner from `embedding_config`.
 * No row (fresh install / DB down) → {@link LOCAL_FALLBACK_CONFIG}.
 *
 * This is the ONLY place embedder selection resolves. There is no per-agent,
 * per-worker, or env override any more — those were collapsed into the one
 * config row in migration 0061.
 *
 * Cached per ownerId for 60s. Mutations on `/settings/embedding` call
 * {@link clearEmbeddingModelCache} so a change kicks in immediately.
 */
export async function resolveEmbeddingConfig(ownerId: string): Promise<EmbeddingConfig> {
  const cached = _resolverCache.get(ownerId);
  if (cached && cached.expiresAt > Date.now()) return cached.config;
  let config: EmbeddingConfig = LOCAL_FALLBACK_CONFIG;
  try {
    const [row] = await db
      .select()
      .from(embeddingConfig)
      .where(eq(embeddingConfig.ownerId, ownerId))
      .limit(1);
    if (row) {
      config = {
        model: row.model,
        dimensions: row.dimensions,
        primary: {
          provider: row.primaryProvider,
          baseUrl: row.primaryBaseUrl ?? null,
          apiKeyId: row.primaryApiKeyId ?? null,
          label: row.primaryLabel ?? 'Primary',
        },
        backup:
          row.backupEnabled && row.backupProvider
            ? {
                provider: row.backupProvider,
                baseUrl: row.backupBaseUrl ?? null,
                apiKeyId: row.backupApiKeyId ?? null,
                label: row.backupLabel ?? 'Backup',
              }
            : null,
      };
    }
  } catch (err) {
    // DB unreachable? Fall back gracefully — embedding still works against the
    // local default. Log so operators notice if it's a persistent state.
    console.warn(
      '[embeddings] resolveEmbeddingConfig: DB lookup failed, using local fallback —',
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
  // Per-call overrides (the re-embed CLI targeting a specific model, the dim
  // probe) apply to the PRIMARY route only; the backup route stays as resolved.
  const config: EmbeddingConfig = {
    model: opts?.model ?? baseConfig.model,
    dimensions: baseConfig.dimensions,
    primary: {
      ...baseConfig.primary,
      provider: opts?.provider ?? baseConfig.primary.provider,
      apiKeyId: opts?.apiKeyId !== undefined ? opts.apiKeyId : baseConfig.primary.apiKeyId,
    },
    backup: baseConfig.backup,
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
        provider: config.primary.provider,
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
  const { model, dimensions } = config;

  // 1. Cache lookup, keyed by (model, content) — ROUTE-independent. Primary
  //    and backup serve the SAME model, so they share cache entries (identical
  //    vectors); a failover never pollutes the cache.
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

  // 3. Embed the misses against ONE route — resolve its adapter + api key,
  //    validate inputs, run the batch loop, mutating `out` + the cache. Runs
  //    for the primary first; the failover below re-runs it on the backup
  //    (same model ⇒ same vector space ⇒ safe) only on a route-down error.
  async function fillMisses(r: EmbeddingRoute): Promise<void> {
    const adapter = getEmbeddingAdapter(r.provider);
    if (!adapter) {
      throw new Error(
        `embed: no adapter registered for provider '${r.provider}'. The embedding ` +
          `config points at an unknown provider — fix it at /settings/embedding.`,
      );
    }
    if (adapter.acceptsInput) {
      for (const item of missInputs) {
        if (!adapter.acceptsInput(item)) {
          const itemType = typeof item === 'string' ? 'text' : item.type;
          throw new Error(
            `embed: input type '${itemType}' not accepted by adapter '${adapter.adapterName}' ` +
              `(model='${model}'). Multimodal inputs require a multimodal-capable provider/model.`,
          );
        }
      }
    }
    // Resolve the api key. Route-pinned id wins; fall back to the provider's
    // canonical service slug; `local` is keyless (self-hosted server).
    let apiKey: string | null = null;
    if (r.apiKeyId) apiKey = await getApiKeyById(r.apiKeyId);
    if (!apiKey) apiKey = await getApiKey(ownerId, r.provider);
    if (!apiKey) {
      if (r.provider === 'local') {
        apiKey = 'local';
      } else {
        throw new Error(
          `embed: no api key for provider '${r.provider}'. Add one at /settings/keys ` +
            `and assign it to the route at /settings/embedding.`,
        );
      }
    }

    for (let start = 0; start < missInputs.length; start += MAX_BATCH) {
      // Only embed slots still null — on a failover the backup picks up
      // exactly what a partial primary run left behind.
      const sliceIdx: number[] = [];
      const slice: EmbedInput[] = [];
      for (let j = start; j < Math.min(start + MAX_BATCH, missInputs.length); j++) {
        const inputIdx = missIndexes[j]!;
        if (out[inputIdx] === null) {
          sliceIdx.push(inputIdx);
          slice.push(missInputs[j]!);
        }
      }
      if (slice.length === 0) continue;
      const result = await adapter.embed({
        apiKey,
        model,
        input: slice,
        // MRL truncation where supported (OpenAI's text-embedding-3-*, Google's
        // gemini-embedding-*); ignored elsewhere. The column is `dimensions`
        // (768) so requesting it everywhere keeps inserts compatible.
        dimensions,
        baseUrl: r.baseUrl ?? undefined,
      });
      apiCalls++;
      if (result.vectors.length !== slice.length) {
        throw new Error(
          `embed: provider returned ${result.vectors.length} vectors for ${slice.length} inputs`,
        );
      }
      const cacheRows = result.vectors.map((vec, j) => {
        const inputIdx = sliceIdx[j]!;
        out[inputIdx] = vec;
        return { contentHash: hashes[inputIdx]!, embedding: vec };
      });
      await db.insert(embeddingCache).values(cacheRows).onConflictDoNothing();
    }
  }

  // 3a. Run primary, fail over to the same-model backup only when the route
  //     is DOWN (connection refused / timeout / 5xx). Bad-input errors (4xx,
  //     unsupported input) rethrow — failover wouldn't help.
  let usedProvider = config.primary.provider;
  let failedOver = false;
  if (missInputs.length > 0) {
    try {
      await fillMisses(config.primary);
    } catch (err) {
      if (config.backup && isRouteDownError(err)) {
        console.warn(
          `[embeddings] primary route '${config.primary.provider}' unavailable — failing over to ` +
            `backup '${config.backup.provider}' (same model '${model}'): ` +
            (err instanceof Error ? err.message : String(err)),
        );
        usedProvider = config.backup.provider;
        failedOver = true;
        await fillMisses(config.backup);
        void stampFailover(ownerId);
      } else {
        throw err;
      }
    }
  }

  // 4. Sanity check.
  for (let i = 0; i < out.length; i++) {
    if (!out[i] || out[i]!.length !== dimensions) {
      throw new Error(
        `embed: missing or wrong-shaped vector at index ${i} (got length=${out[i]?.length ?? 'null'}, expected ${dimensions}). ` +
          `If you just switched models, check the embedding config's dim probe — the picked model may not emit ${dimensions}-dim vectors.`,
      );
    }
  }

  stepHandle?.setMeta({
    cache_hits: inputs.length - missInputs.length,
    cache_misses: missInputs.length,
    api_calls: apiCalls,
    model,
    provider: usedProvider,
    failed_over: failedOver,
  });

  return out as number[][];
}

/**
 * True when an embed error means the ROUTE is unreachable — connection
 * refused, DNS failure, request timeout, or a 5xx from the server. Those are
 * safe to fail over to the same-model backup. A bad-input / 4xx error (or an
 * unsupported-input throw) returns false: a second route wouldn't help and
 * would just burn another call. When uncertain, returns false (don't fail over).
 */
export function isRouteDownError(err: unknown): boolean {
  if (err instanceof Error) {
    // Native fetch network failures surface as TypeError (undici) or an
    // AbortError/TimeoutError when AbortSignal.timeout fires.
    if (err instanceof TypeError) return true;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    const m = err.message;
    if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|fetch failed|network|socket hang up|timed? ?out/i.test(m)) {
      return true;
    }
    // Adapters throw "… failed: <status> <statusText> — …". 5xx = server-side
    // (route down / overloaded); 4xx = bad input (don't fail over).
    if (/\b4\d\d\b/.test(m)) return false;
    if (/\b5\d\d\b/.test(m)) return true;
  }
  return false;
}

/** Best-effort stamp of the last primary→backup failover for the UI. Never
 *  throws — a failed stamp must not break the embed that just succeeded. */
async function stampFailover(ownerId: string): Promise<void> {
  try {
    await db
      .update(embeddingConfig)
      .set({ lastFailoverAt: new Date(), updatedAt: new Date() })
      .where(eq(embeddingConfig.ownerId, ownerId));
  } catch {
    /* best-effort */
  }
}
