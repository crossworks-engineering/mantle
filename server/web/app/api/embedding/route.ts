import { NextResponse } from '@/server/http-compat';
import { listApiKeys } from '@/lib/api-keys';
import { findProviderKeyIds } from '@mantle/api-keys';
import { EMBEDDING_DIMS, getEmbeddingConfig, upsertEmbeddingConfig } from '@/lib/embedding-config';
import { suggestBackupRoute } from '@/lib/embedding-backup';
import { EXTRACTION_CONCURRENCY_MAX } from '@mantle/embeddings';
import { loadProviderAlerts } from '@mantle/content';
import { ownerCaller } from '@/lib/auth';
import { EMBEDDING_ROUTES, modelRoutesRefusal, modelRoutesStamp } from '@/lib/model-route-pair';
import { errorMessage } from '@mantle/std';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { modelPolicyBody, modelRoutesPolicyIssue } from '@/lib/model-policy-save';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

/** The single embedder config + the vector-column dim + the owner's API keys
 *  (for the route key pickers), for /settings/embedding. Also what an admin
 *  must act on (docs/embeddings.md "Provider outages"): the open provider
 *  alerts, and a same-model backup route to add when none is set. */
export async function GET() {
  const user = ownerCaller();
  const [config, keys, keyIds, alerts] = await Promise.all([
    getEmbeddingConfig(user.id),
    listApiKeys(user.id),
    findProviderKeyIds(user.id),
    loadProviderAlerts(user.id),
  ]);
  return NextResponse.json({
    alerts,
    suggestBackup: suggestBackupRoute(config, keyIds),
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
  const user = ownerCaller();
  const body = (await readJson(req)) as Record<string, unknown>;
  const model = str(body.model);
  if (!model) return NextResponse.json({ ok: false, error: 'A model is required' });
  const primaryProvider = str(body.primary_provider) || 'local';
  const backupEnabled = body.backup_enabled === 'on' || body.backup_enabled === true;
  const backupProvider = orNull(body.backup_provider);

  // The box policy's model block (lib/model-policy-save.ts): the embedder
  // is a model like any other.
  const blocked = modelRoutesPolicyIssue([
    [primaryProvider, model, orNull(body.primary_base_url)],
    [backupEnabled ? backupProvider : null, model, orNull(body.backup_base_url)],
  ]);
  if (blocked)
    return NextResponse.json({ ok: false, ...modelPolicyBody(blocked) }, { status: 403 });

  const routes = {
    primaryProvider,
    primaryBaseUrl: orNull(body.primary_base_url),
    primaryApiKeyId: orNull(body.primary_api_key_id),
    backupProvider: backupEnabled ? backupProvider : null,
    backupBaseUrl: backupEnabled ? orNull(body.backup_base_url) : null,
    backupApiKeyId: backupEnabled ? orNull(body.backup_api_key_id) : null,
  };
  // A vault key (the key id, or the provider's key a route without one falls
  // back to) with a base URL of the writer's choosing is the keys area's,
  // and the config records who paired them (lib/model-route-pair.ts).
  const stored = await getEmbeddingConfig(user.id);
  const keysRefused = await modelRoutesRefusal(user, stored, routes, EMBEDDING_ROUTES);
  if (keysRefused) return NextResponse.json({ ok: false, error: keysRefused }, { status: 403 });
  const stamp = modelRoutesStamp(user, stored, routes, EMBEDDING_ROUTES);

  try {
    await upsertEmbeddingConfig(user.id, {
      model,
      primaryProvider,
      primaryBaseUrl: routes.primaryBaseUrl,
      primaryApiKeyId: routes.primaryApiKeyId,
      primaryLabel: orNull(body.primary_label),
      backupEnabled: backupEnabled && !!backupProvider,
      backupProvider: backupEnabled ? backupProvider : null,
      backupBaseUrl: routes.backupBaseUrl,
      backupApiKeyId: routes.backupApiKeyId,
      backupLabel: backupEnabled ? orNull(body.backup_label) : null,
      extractionConcurrency: nullableInt(
        body.extraction_concurrency,
        1,
        EXTRACTION_CONCURRENCY_MAX,
      ),
      extractionTimeBudgetMinutes: nullableInt(body.extraction_time_budget_minutes, 1, 720),
      localEmbedBatchSize: nullableInt(body.local_embed_batch_size, 1, 512),
      localEmbedRequestTimeoutMs: nullableInt(body.local_embed_request_timeout_ms, 1000, 600000),
      ...stamp,
    });
    // No backup route: say which same-model one the brain could add (the
    // form offers it). A save also tells the agent to probe and recover
    // (upsertEmbeddingConfig).
    const [saved, keyIds] = await Promise.all([
      getEmbeddingConfig(user.id),
      findProviderKeyIds(user.id),
    ]);
    return NextResponse.json({ ok: true, model, suggestBackup: suggestBackupRoute(saved, keyIds) });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: errorMessage(err),
    });
  }
}
