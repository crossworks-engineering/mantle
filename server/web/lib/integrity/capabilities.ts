/**
 * Brain-readiness probe — which optional services + workers are actually
 * available right now. Drives two things:
 *   1. Phase 2e hard-gating: a Tika/vision-routed fixture expects "indexed"
 *      when its service is up, and the correct skip when it's down.
 *   2. The readiness panel: surfaces the Dialog/voice machinery (summarizer,
 *      reflector, stt) that's too heavy/non-deterministic to synthesise in a
 *      probe — "is it wired and ready?" is the integrity signal we can give.
 *
 * Vision mirrors the runtime check (`runVisionWorker`): a worker with a usable
 * api key. The local-keyless workers (extractor/summarizer/… on local models)
 * don't require a key, so those only check that a worker is configured.
 */
import { db, sql, getDefaultWorker, type AiWorkerKind } from '@mantle/db';
import { tikaIsUp } from '@mantle/files';

import type { Capability, Capabilities } from '@mantle/web-ui/types/integrity';

async function workerCap(
  ownerId: string,
  kind: AiWorkerKind,
  requireKey: boolean,
): Promise<Capability> {
  const w = await getDefaultWorker(ownerId, kind);
  if (!w) return { available: false, detail: `no ${kind} worker configured` };
  if (requireKey && !w.apiKeyId) return { available: false, detail: `${w.slug}: no api key` };
  return { available: true, detail: `${w.slug} · ${w.model}` };
}

type EmbedCfgRow = { model: string; provider: string; base_url: string | null };

/**
 * Embedding readiness reads `embedding_config` — NOT an `ai_workers` row. Since
 * the migration-0061 consolidation the embedder is a singleton config, so the
 * old `getDefaultWorker(ownerId, 'embedding')` always found nothing and the
 * panel falsely showed the embedder "off" even while it was happily embedding.
 * For the `local` provider we additionally probe the server's /models (same
 * lightweight check as the dashboard vitals pill) so a genuinely-down embedder
 * shows red — the only state in which the brain truly can't embed.
 */
async function embeddingCap(ownerId: string): Promise<Capability> {
  const res = await db.execute<EmbedCfgRow>(sql`
    SELECT model, primary_provider AS provider, primary_base_url AS base_url
    FROM embedding_config WHERE owner_id = ${ownerId} LIMIT 1`);
  const row = (Array.isArray(res) ? res : ((res as { rows?: EmbedCfgRow[] }).rows ?? []))[0];
  if (!row) return { available: false, detail: 'no embedding_config row' };
  const { model, provider } = row;
  if (provider !== 'local') return { available: true, detail: `${model} · ${provider}` };
  const base = (
    row.base_url ||
    process.env.MANTLE_LOCAL_EMBEDDING_URL ||
    'http://localhost:11434/v1'
  ).replace(/\/+$/, '');
  try {
    const probe = await fetch(`${base}/models`, { signal: AbortSignal.timeout(1_500) });
    if (!probe.ok)
      return { available: false, detail: `local embedder unreachable (HTTP ${probe.status})` };
    const body = (await probe.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((x): x is string => typeof x === 'string');
    const norm = (s: string) => s.replace(/:latest$/, '');
    return ids.some((id) => norm(id) === norm(model))
      ? { available: true, detail: `${model} · loaded (local)` }
      : { available: false, detail: `${model} not loaded on local embedder` };
  } catch {
    return { available: false, detail: 'local embedder unreachable' };
  }
}

export async function resolveCapabilities(ownerId: string): Promise<Capabilities> {
  const [tikaUp, vision, extractor, embedding, summarizer, reflector, stt] = await Promise.all([
    tikaIsUp().catch(() => false),
    workerCap(ownerId, 'vision', true),
    workerCap(ownerId, 'extractor', false),
    embeddingCap(ownerId),
    workerCap(ownerId, 'summarizer', false),
    workerCap(ownerId, 'reflector', false),
    workerCap(ownerId, 'stt', false),
  ]);
  return {
    tika: {
      available: tikaUp,
      detail: tikaUp ? 'reachable' : 'unreachable (set TIKA_URL / start the service)',
    },
    vision,
    extractor,
    embedding,
    summarizer,
    reflector,
    stt,
  };
}
