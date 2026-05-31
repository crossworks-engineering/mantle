/**
 * Server-side read/write for the single embedding_config row — the one place
 * the embedder is configured (migration 0061). The resolver in
 * `@mantle/embeddings` reads the same row at runtime; writing here clears its
 * cache so a change takes effect immediately.
 */
import { eq } from 'drizzle-orm';
import { db, embeddingConfig, type EmbeddingConfigRow } from '@mantle/db';
import { clearEmbeddingModelCache, EMBEDDING_DIMS } from '@mantle/embeddings';

export { EMBEDDING_DIMS };
export type { EmbeddingConfigRow };

export type EmbeddingConfigInput = {
  model: string;
  primaryProvider: string;
  primaryBaseUrl: string | null;
  primaryApiKeyId: string | null;
  primaryLabel: string | null;
  backupEnabled: boolean;
  backupProvider: string | null;
  backupBaseUrl: string | null;
  backupApiKeyId: string | null;
  backupLabel: string | null;
};

export async function getEmbeddingConfig(ownerId: string): Promise<EmbeddingConfigRow | null> {
  const [row] = await db
    .select()
    .from(embeddingConfig)
    .where(eq(embeddingConfig.ownerId, ownerId))
    .limit(1);
  return row ?? null;
}

/**
 * Upsert the singleton. `dimensions` is pinned to the column shape
 * (EMBEDDING_DIMS) — changing the embedding dimension is a schema migration,
 * not a form field. Clears the resolver cache so the change is live at once.
 */
export async function upsertEmbeddingConfig(
  ownerId: string,
  input: EmbeddingConfigInput,
): Promise<void> {
  const now = new Date();
  const row = { dimensions: EMBEDDING_DIMS, ...input, updatedAt: now };
  await db
    .insert(embeddingConfig)
    .values({ ownerId, ...row })
    .onConflictDoUpdate({ target: embeddingConfig.ownerId, set: row });
  clearEmbeddingModelCache(ownerId);
}
