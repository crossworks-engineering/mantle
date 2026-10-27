/**
 * Brain-readiness probe — which optional services + workers are actually
 * available right now. Drives two things:
 *   1. Phase 2e hard-gating: a parser/vision-routed fixture expects "indexed"
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
import { parserHealth } from '@mantle/files';

import type { Capability, Capabilities } from '@mantle/client-types/types/integrity';
import { env } from '@mantle/config';
import { NET_TIMEOUTS } from '@mantle/std';
import { providerHealth } from '@mantle/voice';

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
    env('MANTLE_LOCAL_EMBEDDING_URL') ||
    'http://localhost:11434/v1'
  ).replace(/\/+$/, '');
  // THE local model probe (@mantle/voice providerHealth, A10 #10).
  const probe = await providerHealth(base, { timeoutMs: NET_TIMEOUTS.localProbe, model });
  if (!probe.up && probe.reason === 'http') {
    return { available: false, detail: `local embedder unreachable (HTTP ${probe.status})` };
  }
  if (!probe.up || probe.ids === null) {
    return { available: false, detail: 'local embedder unreachable' };
  }
  return probe.loaded
    ? { available: true, detail: `${model} · loaded (local)` }
    : { available: false, detail: `${model} not loaded on local embedder` };
}

export async function resolveCapabilities(ownerId: string): Promise<Capabilities> {
  const [parserH, vision, extractor, embedding, summarizer, reflector, stt] = await Promise.all([
    parserHealth(NET_TIMEOUTS.localProbe),
    workerCap(ownerId, 'vision', true),
    workerCap(ownerId, 'extractor', false),
    embeddingCap(ownerId),
    workerCap(ownerId, 'summarizer', false),
    workerCap(ownerId, 'reflector', false),
    workerCap(ownerId, 'stt', false),
  ]);
  const v = parserH.versions;
  const parser: Capability = parserH.up
    ? {
        available: true,
        detail:
          `node ${v.node ?? '?'} · anydoc ${v.anydoc ?? '?'} · ` +
          (v.ezdxf ? `ezdxf ${v.ezdxf}` : 'CAD tier missing (DWG/DXF files error at extract)') +
          ` · ffmpeg ${v.ffmpeg ?? 'missing'}`,
      }
    : { available: false, detail: 'unreachable (is the parser container running? PARSER_URL)' };
  return {
    parser,
    tika: parser,
    vision,
    extractor,
    embedding,
    summarizer,
    reflector,
    stt,
    media: { available: false, detail: 'removed (the parser service reads uploaded video)' },
  };
}
