/**
 * Server-side read/write for the single embedding_config row — the one place
 * the embedder is configured (migration 0061). The resolver in
 * `@mantle/embeddings` reads the same row at runtime; writing here clears its
 * cache so a change takes effect immediately.
 */
import { eq, sql } from 'drizzle-orm';
import {
  db,
  type EmbeddingConfigRow,
  embeddingConfig,
  executeWrite,
  requestProviderProbeNow,
} from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
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
  // Performance / throughput tuning (null → env → code default).
  extractionConcurrency: number | null;
  extractionTimeBudgetMinutes: number | null;
  localEmbedBatchSize: number | null;
  localEmbedRequestTimeoutMs: number | null;
  /** The login that paired a route's vault key with its base URL (W7a fix
   *  round 5); null for the brain owner. Absent: the stored one stays. */
  configuredBy?: string | null;
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
  await notifyProviderRecover(ownerId);
}

/**
 * Tell the agent the provider settings changed (docs/embeddings.md "Provider
 * outages"): it probes an open alert at once and, when the provider works,
 * re-drives the dead letters and sweeps unextracted nodes, with no restart.
 * The agent bounds it (one tiny probe call; a recovery at most once per
 * 2 min). Best-effort: the agent's 30 s config poll catches a lost notify.
 */
export async function notifyProviderRecover(ownerId: string): Promise<void> {
  try {
    await executeWrite(sql`SELECT pg_notify('provider_recover', ${ownerId}::text)`);
  } catch {
    /* best-effort */
  }
}

/**
 * "Try again" (A10 lows): every open provider alert probes on the agent's
 * next tick, and the agent is told at once (notifyProviderRecover). The
 * Admin "Try again" button calls it, and so does a change to a key's
 * credential (PATCH /api/keys/:id for the Anthropic workspace id, the key's
 * rotate, a key set again by POST /api/keys), so a fixed key clears its
 * alert and resumes the extract queue without waiting for the probe's
 * backoff. Cheap and bounded: one UPDATE and one NOTIFY here, no model
 * call; the agent makes one tiny probe call per open alert and recovers at
 * most once per 2 min (provider-circuit.ts), however often this is called.
 * Returns how many open alerts will probe; throws as the button always did
 * when the alerts cannot be read (a key route uses {@link
 * retryProvidersAfterKeyChange}, which never throws).
 */
export async function retryProvidersNow(ownerId: string): Promise<number> {
  const probing = await requestProviderProbeNow(ownerId);
  await notifyProviderRecover(ownerId);
  return probing;
}

/**
 * {@link retryProvidersNow} after a key's credential changed: best-effort,
 * logged and never thrown, because the key's own write already succeeded
 * and its answer must not turn into an error over a nudge.
 */
export async function retryProvidersAfterKeyChange(ownerId: string): Promise<void> {
  try {
    await retryProvidersNow(ownerId);
  } catch (err) {
    log('keys').error(`could not ask the provider alerts to probe: ${errorMessage(err)}`);
  }
}
