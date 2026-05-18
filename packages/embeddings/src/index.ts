/**
 * Embeddings — the shared utility every memory layer leans on.
 *
 *   embed(text)       → vector(1536), cached by content hash.
 *   embedBatch(texts) → vector(1536)[], cached per-input.
 *
 * Backed by OpenRouter (`openai/text-embedding-3-small`, 1536 dims) using
 * the existing `openrouter` key from @mantle/api-keys. Cache lives in the
 * `embedding_cache` table keyed by sha256(model || ':' || text), so
 * re-embedding identical strings is a single SELECT.
 */

import { createHash } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { db, embeddingCache } from '@mantle/db';
import { getApiKey } from '@mantle/api-keys';
import { currentTrace, step } from '@mantle/tracing';
import { callEmbeddings } from './client.js';

export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
export const EMBEDDING_DIMS = 1536;

/** OpenRouter caps batch size; 100 is well inside provider limits. */
const MAX_BATCH = 100;

function hashKey(model: string, text: string): string {
  return createHash('sha256').update(`${model}:${text}`).digest('hex');
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
 * Embed multiple texts at once. Hits the cache for each input first;
 * remaining misses go to OpenRouter in batches of MAX_BATCH. Order of the
 * returned array matches the input order.
 */
export async function embedBatch(
  ownerId: string,
  texts: string[],
  opts?: { model?: string },
): Promise<number[][]> {
  // No trace → fast path with no instrumentation overhead.
  if (!currentTrace()) {
    return doEmbedBatch(ownerId, texts, opts);
  }
  return step(
    {
      name: 'embed_batch',
      kind: 'embed',
      input: { count: texts.length, model: opts?.model ?? DEFAULT_EMBEDDING_MODEL },
    },
    async (handle) => {
      const result = await doEmbedBatch(ownerId, texts, opts, handle);
      return result;
    },
  );
}

type EmbedStepHandle = { setMeta(m: Record<string, unknown>): void };

async function doEmbedBatch(
  ownerId: string,
  texts: string[],
  opts?: { model?: string },
  stepHandle?: EmbedStepHandle,
): Promise<number[][]> {
  const model = opts?.model ?? DEFAULT_EMBEDDING_MODEL;
  if (texts.length === 0) return [];

  const hashes = texts.map((t) => hashKey(model, t));
  const out: (number[] | null)[] = texts.map(() => null);

  // 1. Lookup cache in bulk.
  const cachedRows = await db
    .select({ contentHash: embeddingCache.contentHash, embedding: embeddingCache.embedding })
    .from(embeddingCache)
    .where(inArray(embeddingCache.contentHash, hashes));
  const cacheMap = new Map<string, number[]>();
  for (const row of cachedRows) cacheMap.set(row.contentHash, row.embedding);
  for (let i = 0; i < texts.length; i++) {
    const cached = cacheMap.get(hashes[i]!);
    if (cached) out[i] = cached;
  }

  // 2. Compute misses.
  const missIndexes: number[] = [];
  const missTexts: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (out[i] === null) {
      missIndexes.push(i);
      missTexts.push(texts[i]!);
    }
  }

  let apiCalls = 0;
  if (missTexts.length > 0) {
    const apiKey = await getApiKey(ownerId, 'openrouter');
    if (!apiKey) {
      throw new Error(
        "embed: no 'openrouter' api key for owner — add one at /settings/keys",
      );
    }

    // Call in batches of MAX_BATCH.
    for (let start = 0; start < missTexts.length; start += MAX_BATCH) {
      const slice = missTexts.slice(start, start + MAX_BATCH);
      const vectors = await callEmbeddings(apiKey, { model, input: slice });
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
    cache_hits: texts.length - missTexts.length,
    cache_misses: missTexts.length,
    api_calls: apiCalls,
    model,
  });

  return out as number[][];
}
