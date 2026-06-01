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
import { getDefaultWorker, type AiWorkerKind } from '@mantle/db';
import { tikaIsUp } from '@mantle/files';

import type { Capability, Capabilities } from './types';

async function workerCap(ownerId: string, kind: AiWorkerKind, requireKey: boolean): Promise<Capability> {
  const w = await getDefaultWorker(ownerId, kind);
  if (!w) return { available: false, detail: `no ${kind} worker configured` };
  if (requireKey && !w.apiKeyId) return { available: false, detail: `${w.slug}: no api key` };
  return { available: true, detail: `${w.slug} · ${w.model}` };
}

export async function resolveCapabilities(ownerId: string): Promise<Capabilities> {
  const [tikaUp, vision, extractor, embedding, summarizer, reflector, stt] = await Promise.all([
    tikaIsUp().catch(() => false),
    workerCap(ownerId, 'vision', true),
    workerCap(ownerId, 'extractor', false),
    workerCap(ownerId, 'embedding', false),
    workerCap(ownerId, 'summarizer', false),
    workerCap(ownerId, 'reflector', false),
    workerCap(ownerId, 'stt', false),
  ]);
  return {
    tika: { available: tikaUp, detail: tikaUp ? 'reachable' : 'unreachable (set TIKA_URL / start the service)' },
    vision,
    extractor,
    embedding,
    summarizer,
    reflector,
    stt,
  };
}
