'use server';

/**
 * Server actions for /settings/embedding — the single embedder config.
 *
 *  - saveEmbeddingConfigAction: upsert the one row (primary + backup routes).
 *  - testEmbeddingRouteAction: probe ONE route's live output dimension.
 *  - rebuildEmbeddingIndexAction: re-embed the corpus against the saved model.
 */

import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/lib/auth';
import { upsertEmbeddingConfig } from '@/lib/embedding-config';
import {
  probeEmbeddingRoute,
  resolveEmbeddingModel,
  runReembed,
  type ReembedResult,
} from '@mantle/embeddings';

function str(v: FormDataEntryValue | null): string {
  return typeof v === 'string' ? v.trim() : '';
}
function orNull(v: FormDataEntryValue | null): string | null {
  const s = str(v);
  return s.length > 0 ? s : null;
}

export async function saveEmbeddingConfigAction(formData: FormData): Promise<void> {
  const user = await requireOwner();
  const model = str(formData.get('model'));
  if (!model) throw new Error('A model is required');
  const primaryProvider = str(formData.get('primary_provider')) || 'local';
  const backupEnabled = formData.get('backup_enabled') === 'on';
  const backupProvider = orNull(formData.get('backup_provider'));

  await upsertEmbeddingConfig(user.id, {
    model,
    primaryProvider,
    primaryBaseUrl: orNull(formData.get('primary_base_url')),
    primaryApiKeyId: orNull(formData.get('primary_api_key_id')),
    primaryLabel: orNull(formData.get('primary_label')),
    // Backup is the SAME model on a different route — never a different model.
    backupEnabled: backupEnabled && !!backupProvider,
    backupProvider: backupEnabled ? backupProvider : null,
    backupBaseUrl: backupEnabled ? orNull(formData.get('backup_base_url')) : null,
    backupApiKeyId: backupEnabled ? orNull(formData.get('backup_api_key_id')) : null,
    backupLabel: backupEnabled ? orNull(formData.get('backup_label')) : null,
  });
  revalidatePath('/settings/embedding');
}

/** Probe one route's live output dimension (bypasses resolver + cache). */
export async function testEmbeddingRouteAction(route: {
  provider: string;
  model: string;
  baseUrl: string | null;
  apiKeyId: string | null;
}): Promise<{ ok: true; dimensions: number } | { ok: false; error: string }> {
  const user = await requireOwner();
  if (!route.model.trim()) return { ok: false, error: 'No model set' };
  try {
    const dimensions = await probeEmbeddingRoute(user.id, route);
    return { ok: true, dimensions };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Re-embed the corpus against the saved model. Use after changing the model
 * (or to repopulate). Idempotent under the embedding_cache, so re-running on an
 * unchanged model is cheap.
 */
export async function rebuildEmbeddingIndexAction(
  repopulate: boolean,
): Promise<{ ok: true; model: string; result: ReembedResult } | { ok: false; error: string }> {
  const user = await requireOwner();
  try {
    const model = await resolveEmbeddingModel(user.id);
    const result = await runReembed(user.id, { model, includeUnembedded: repopulate });
    return { ok: true, model, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
