/**
 * Pinned-model drift — the DB + network half.
 *
 * Split from `pinned-model-drift.ts` so the judgement is pure and testable
 * without a database or a network (the `deps-drift` / `runEntitiesDedupe`
 * pattern). This file only gathers: which models this brain has pinned, and
 * what each provider currently lists. Everything it learns goes through
 * `classifyPins`.
 *
 * Lives in `lib/` rather than the script so the nightly cron runs the SAME
 * definition — the cron dispatches in-process and never spawns scripts, so a
 * report that exists only inside a script can be marked schedulable and never
 * run once (which is exactly what happened to `deps-drift`).
 *
 * Read-only and free: selects two tables, calls each provider's list endpoint
 * once (cached 5 min by the explorer), invokes no model, writes nothing.
 */

import { db, agents, aiWorkers, eq } from '@mantle/db';
import { explorerCanFetch, fetchProviderModels } from '../model-explorer';
import { isProviderId } from '@mantle/voice';
import {
  classifyPins,
  type PinKind,
  type PinnedModel,
  type PinnedModelDriftResult,
  type ProviderCatalog,
} from './pinned-model-drift';

/**
 * A worker template whose model resolves at execution time from whichever
 * responder runs it (migration 0131). There is no id to check, and reporting
 * the literal string as a missing model would be noise on every brain.
 */
const INHERIT = 'inherit';

/**
 * Providers that point at whatever the operator is self-hosting. Their model
 * ids are true by definition — whatever the box serves is the catalogue — so
 * there is nothing to drift against.
 */
const SELF_HOSTED = new Set(['local', 'custom']);

/**
 * Worker kind → the modality its model is used for.
 *
 * The pin's modality comes from the ROW, never from the catalogue: a `tts`
 * worker is a TTS pin regardless of how any provider classifies the id. This
 * is what stops a chat-only catalogue from marking every voice worker retired.
 * Text-in/text-out workers (extractor, summarizer, reflector, …) are chat
 * models and are checked as such.
 */
function kindForWorker(workerKind: string): PinKind {
  switch (workerKind) {
    case 'tts':
      return 'tts';
    case 'stt':
      return 'stt';
    case 'embedding':
      return 'embedding';
    case 'image_gen':
      return 'image';
    default:
      return 'chat';
  }
}

/** Every model this brain would actually send, with where it is configured. */
export async function collectPins(): Promise<{ pins: PinnedModel[]; ownerId: string | null }> {
  const [agentRows, workerRows] = await Promise.all([
    db
      .select({
        slug: agents.slug,
        provider: agents.provider,
        model: agents.model,
        ownerId: agents.ownerId,
      })
      .from(agents)
      .where(eq(agents.enabled, true)),
    db
      .select({ kind: aiWorkers.kind, provider: aiWorkers.provider, model: aiWorkers.model })
      .from(aiWorkers)
      .where(eq(aiWorkers.enabled, true)),
  ]);

  const pins: PinnedModel[] = [];
  for (const a of agentRows) {
    if (!a.model || a.model === INHERIT) continue;
    pins.push({ ref: `agent:${a.slug}`, provider: a.provider, model: a.model, kind: 'chat' });
  }
  for (const w of workerRows) {
    if (!w.model || w.model === INHERIT) continue;
    pins.push({
      ref: `worker:${w.kind}`,
      provider: w.provider,
      model: w.model,
      kind: kindForWorker(w.kind),
    });
  }
  // All content hangs off one anchor, so any agent row carries the id the
  // keyed provider fetches need.
  return { pins, ownerId: agentRows[0]?.ownerId ?? null };
}

/** Fetch one catalogue, converting every can't-see case into an explicit
 *  reason rather than an empty list (an empty list would read as "everything
 *  is missing"). */
async function catalogFor(ownerId: string | null, provider: string): Promise<ProviderCatalog> {
  if (SELF_HOSTED.has(provider)) {
    return { ok: false, reason: 'self-hosted — the endpoint defines its own models' };
  }
  if (!isProviderId(provider) || !explorerCanFetch(provider)) {
    return { ok: false, reason: 'provider publishes no model list' };
  }
  if (!ownerId) return { ok: false, reason: 'no owner resolved for the key lookup' };

  const res = await fetchProviderModels(ownerId, provider);
  if (res.unsupported) return { ok: false, reason: 'provider publishes no model list' };
  if (res.needsKey) return { ok: false, reason: 'no stored API key to authenticate the list call' };
  if (res.error) return { ok: false, reason: `list call failed — ${res.error}` };
  if (res.models.length === 0) return { ok: false, reason: 'provider returned an empty list' };
  return { ok: true, entries: res.models.map((m) => ({ id: m.id, kind: m.kind })) };
}

export async function runPinnedModelDrift(): Promise<PinnedModelDriftResult> {
  const { pins, ownerId } = await collectPins();
  const providers = [...new Set(pins.map((p) => p.provider))];
  const catalogs = new Map<string, ProviderCatalog>();
  for (const p of providers) catalogs.set(p, await catalogFor(ownerId, p));
  return classifyPins(pins, catalogs);
}
