import { NextResponse } from 'next/server';
import { listApiKeys } from '@/lib/api-keys';
import { EMBEDDING_DIMS, getEmbeddingConfig, upsertEmbeddingConfig } from '@/lib/embedding-config';
import { getOwnerOr401 } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** The single embedder config + the vector-column dim + the owner's API keys
 *  (for the route key pickers), for /settings/embedding. */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [config, keys] = await Promise.all([getEmbeddingConfig(user.id), listApiKeys(user.id)]);
  return NextResponse.json({
    config: config
      ? {
          model: config.model,
          dimensions: config.dimensions,
          primaryProvider: config.primaryProvider,
          primaryBaseUrl: config.primaryBaseUrl,
          primaryApiKeyId: config.primaryApiKeyId,
          primaryLabel: config.primaryLabel,
          backupEnabled: config.backupEnabled,
          backupProvider: config.backupProvider,
          backupBaseUrl: config.backupBaseUrl,
          backupApiKeyId: config.backupApiKeyId,
          backupLabel: config.backupLabel,
          lastFailoverAt: config.lastFailoverAt?.toISOString() ?? null,
          extractionConcurrency: config.extractionConcurrency,
          extractionTimeBudgetMinutes: config.extractionTimeBudgetMinutes,
          localEmbedBatchSize: config.localEmbedBatchSize,
          localEmbedRequestTimeoutMs: config.localEmbedRequestTimeoutMs,
        }
      : null,
    columnDims: EMBEDDING_DIMS,
    keys: keys.map((k) => ({ id: k.id, service: k.service, label: k.label, masked: k.masked })),
  });
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function orNull(v: unknown): string | null {
  const s = str(v);
  return s.length > 0 ? s : null;
}
/** Optional integer field, clamped to [min,max]. Blank → null (resolver then
 *  falls back to env → code default). */
function nullableInt(v: unknown, min: number, max: number): number | null {
  const s = str(v);
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, min), max);
}

/** Upsert the one embedder config row (primary + backup routes + perf knobs).
 *  Body carries the same snake_case fields the form posts. */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const model = str(body.model);
  if (!model) return NextResponse.json({ ok: false, error: 'A model is required' });
  const primaryProvider = str(body.primary_provider) || 'local';
  const backupEnabled = body.backup_enabled === 'on' || body.backup_enabled === true;
  const backupProvider = orNull(body.backup_provider);

  try {
    await upsertEmbeddingConfig(user.id, {
      model,
      primaryProvider,
      primaryBaseUrl: orNull(body.primary_base_url),
      primaryApiKeyId: orNull(body.primary_api_key_id),
      primaryLabel: orNull(body.primary_label),
      backupEnabled: backupEnabled && !!backupProvider,
      backupProvider: backupEnabled ? backupProvider : null,
      backupBaseUrl: backupEnabled ? orNull(body.backup_base_url) : null,
      backupApiKeyId: backupEnabled ? orNull(body.backup_api_key_id) : null,
      backupLabel: backupEnabled ? orNull(body.backup_label) : null,
      extractionConcurrency: nullableInt(body.extraction_concurrency, 1, 8),
      extractionTimeBudgetMinutes: nullableInt(body.extraction_time_budget_minutes, 1, 720),
      localEmbedBatchSize: nullableInt(body.local_embed_batch_size, 1, 512),
      localEmbedRequestTimeoutMs: nullableInt(body.local_embed_request_timeout_ms, 1000, 600000),
    });
    return NextResponse.json({ ok: true, model });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
