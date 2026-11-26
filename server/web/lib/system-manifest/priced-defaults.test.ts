/**
 * Every model a brain ships with has a cost source (docs/spend-recording.md,
 * "Cost"): its adapter returns the provider's billed cost, or its route is
 * free, or the static price table has a row for it. A shipped model with
 * none of the three is a paid call recorded at $0.
 *
 * Why: on 2026-11-26 a box showed about 13 USD of spend where the provider
 * billed about 75. The read worker's shipped model had no price row and its
 * adapter left the reported cost behind; the shipped online embedder, on its
 * direct route, records an id the table did not have.
 *
 * A new shipped model: give it a row in packages/tracing/src/pricing.ts
 * (the provider's public price list; say the source and the date).
 */
import { describe, expect, it } from 'vitest';
import {
  isFreeCall,
  listPriceMicroUsd,
  type SpendCapability,
  type UnitKind,
} from '@mantle/tracing';
import { REPORTS_COST } from '@mantle/voice';
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_ONLINE_EMBEDDING_MODEL,
  DEFAULT_ONLINE_EMBEDDING_PROVIDER,
} from '@mantle/embeddings';
import { WORKER_MODEL_INHERIT } from '@mantle/runs';
import { MANIFEST_AGENTS, MANIFEST_WORKERS } from './manifest';
import { AGENT_PROVIDER } from './model-check';

/** The capability a worker kind's calls are recorded as; chat for the rest. */
const WORKER_CAPABILITY: Record<string, SpendCapability> = {
  vision: 'vision',
  document: 'vision',
  scan_reader: 'vision',
  image_gen: 'image_gen',
  tts: 'tts',
  stt: 'stt',
  search: 'research',
  search_advanced: 'research',
  decider: 'decision',
};

/** The unit a capability is billed by, when it is not billed by the token. */
const UNIT: Partial<Record<SpendCapability, UnitKind>> = {
  image_gen: 'images',
  tts: 'characters',
  stt: 'audio_seconds',
};

type Route = { what: string; provider: string; model: string; capability: SpendCapability };

function hasRow(r: Route): boolean {
  const unit = UNIT[r.capability];
  return (
    listPriceMicroUsd(
      r.model,
      { input: 1, output: 1 },
      unit ? { kind: unit, count: 1 } : undefined,
    ) !== null
  );
}

function costSource(r: Route): 'reported' | 'free' | 'table' | null {
  if (REPORTS_COST[r.provider]?.includes(r.capability)) return 'reported';
  if (isFreeCall(r.provider, r.model)) return 'free';
  return hasRow(r) ? 'table' : null;
}

function shippedRoutes(): Route[] {
  const routes: Route[] = [];
  for (const a of MANIFEST_AGENTS) {
    // The worker agent takes its model from the box: it ships none.
    if (a.model === WORKER_MODEL_INHERIT) continue;
    routes.push({
      what: `agent ${a.slug}`,
      provider: AGENT_PROVIDER,
      model: a.model,
      capability: 'chat',
    });
  }
  for (const w of MANIFEST_WORKERS) {
    const capability = WORKER_CAPABILITY[w.kind] ?? 'chat';
    const what = `worker ${w.kind}`;
    routes.push({ what, provider: w.provider, model: w.model, capability });
    if (w.altProvider && w.altModel) {
      routes.push({
        what: `${what} (alt)`,
        provider: w.altProvider,
        model: w.altModel,
        capability,
      });
    }
    // A second model a worker names in its params (`fallback_model`, ...).
    for (const [key, value] of Object.entries(w.params ?? {})) {
      if (key.endsWith('_model') && typeof value === 'string') {
        routes.push({ what: `${what} ${key}`, provider: w.provider, model: value, capability });
      }
    }
  }
  // The embedders onboarding offers: the keyless local one, and the online
  // one on its direct route (the bare id) and on OpenRouter (the slug).
  const embed = (provider: string, model: string): Route => ({
    what: `embedder ${provider}`,
    provider,
    model,
    capability: 'embedding',
  });
  routes.push(
    embed('local', DEFAULT_EMBEDDING_MODEL),
    embed(DEFAULT_ONLINE_EMBEDDING_PROVIDER, DEFAULT_ONLINE_EMBEDDING_MODEL),
    embed(DEFAULT_ONLINE_EMBEDDING_PROVIDER, 'text-embedding-3-small'),
    embed('openrouter', `openai/${DEFAULT_ONLINE_EMBEDDING_MODEL}`),
  );
  return routes;
}

describe('shipped models: every one has a cost source', () => {
  const routes = shippedRoutes();

  it('walks the agents, the workers with their alt routes, and the embedders', () => {
    expect(routes.length).toBeGreaterThan(MANIFEST_WORKERS.length);
    expect(routes.some((r) => r.what.endsWith('(alt)'))).toBe(true);
    expect(routes.some((r) => r.capability === 'embedding' && r.provider === 'openai')).toBe(true);
  });

  it('a reported cost, a free route, or a row in the price table', () => {
    const none = routes.filter((r) => costSource(r) === null);
    expect(none.map((r) => `${r.what}: ${r.provider} ${r.model}`)).toEqual([]);
  });

  it('a token-billed model has a price row as well, as a floor under the reported cost', () => {
    // The reported cost is the truth. The row is what a reply with no cost
    // falls back to, so the call is never an unpriced $0.
    const noFloor = routes.filter(
      (r) => !UNIT[r.capability] && !isFreeCall(r.provider, r.model) && !hasRow(r),
    );
    expect(noFloor.map((r) => `${r.what}: ${r.provider} ${r.model}`)).toEqual([]);
  });

  it('the check itself fails a paid model with no source', () => {
    const made = { what: 'x', provider: 'anthropic', model: 'made-up-model' } as const;
    expect(costSource({ ...made, capability: 'chat' })).toBeNull();
    // OpenRouter speech answers with raw audio and no cost: it needs a row.
    expect(
      costSource({ what: 'x', provider: 'openrouter', model: 'made-up/tts', capability: 'tts' }),
    ).toBeNull();
  });
});
