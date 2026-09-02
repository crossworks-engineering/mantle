/**
 * Model-catalogue drift — what our providers serve that we don't list, and what
 * we list that they no longer serve.
 *
 * The computation, split out of `scripts/models-drift.ts` so the CLI and the
 * nightly cron run ONE definition. The cron dispatches in-process and never
 * spawns scripts, so a report that lives only inside a script cannot be
 * scheduled.
 *
 * Read-only: decrypts stored keys to authenticate the list calls, calls each
 * provider's models endpoint once, writes nothing. No model is invoked, so
 * there is no token spend.
 */

import { db, apiKeys } from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import { catalogDrift, getChatAdapter, getProvider } from '@mantle/voice';
import { errorMessage } from '@mantle/std';

/** Providers whose catalogue is a fallback, not a curated list — their
 *  discovery builds `available` from the live response, so "drift" is not a
 *  thing that can happen to them. */
const SELF_UPDATING = new Set(['openrouter', 'copilot', 'local', 'custom']);

/**
 * Anthropic's Models API returns dated snapshot ids while our catalogue holds
 * the alias. Without this every snapshot reads as a brand-new model forever,
 * and a report that is never clean is a report nobody opens.
 */
export function aliasFor(service: string): ((liveId: string) => string | undefined) | undefined {
  if (service !== 'anthropic') return undefined;
  return (liveId) => {
    const m = /^(.*)-\d{8}$/.exec(liveId);
    return m ? m[1] : undefined;
  };
}

export type ProviderDrift = {
  service: string;
  label: string;
  /** They serve it, we don't list it — nobody can pick a model that exists. */
  unlisted: string[];
  /** We list it, they dropped it — picking it fails at request time. */
  stale: string[];
};

export type ModelsDriftResult = {
  /** Providers with a stored key that we attempted. */
  checked: number;
  drift: ProviderDrift[];
  /** Providers that cannot drift by construction, with the reason. */
  skipped: string[];
  /** Providers we could not look at — NOT the same as "clean". */
  unchecked: string[];
};

/** Compute the report. Shared by `scripts/models-drift.ts` and the nightly sweep. */
export async function runModelsDrift(): Promise<ModelsDriftResult> {
  // One key per service is enough to list models — a second key on the same
  // provider sees the same catalogue. Take the oldest, which is the most likely
  // to still be valid.
  const rows = await db
    .select({ id: apiKeys.id, service: apiKeys.service })
    .from(apiKeys)
    .orderBy(apiKeys.createdAt);
  const firstKeyByService = new Map<string, string>();
  for (const r of rows)
    if (!firstKeyByService.has(r.service)) firstKeyByService.set(r.service, r.id);

  const drift: ProviderDrift[] = [];
  const skipped: string[] = [];
  const unchecked: string[] = [];

  for (const [service, keyId] of firstKeyByService) {
    const label = getProvider(service)?.label ?? service;
    if (SELF_UPDATING.has(service)) {
      skipped.push(`${label} — builds its list from the provider, cannot drift`);
      continue;
    }
    const adapter = getChatAdapter(service);
    if (!adapter?.discoverModels || !adapter.staticCatalog) {
      skipped.push(`${label} — no curated chat catalogue to compare against`);
      continue;
    }

    const apiKey = await getApiKeyById(keyId);
    if (!apiKey) {
      unchecked.push(`${label} — key could not be decrypted (MANTLE_MASTER_KEY?)`);
      continue;
    }

    let result;
    try {
      result = await adapter.discoverModels(apiKey);
    } catch (err) {
      // One unreachable provider must not abort the sweep for the rest.
      unchecked.push(`${label} — ${errorMessage(err)}`);
      continue;
    }

    if (!result.liveIds) {
      // The call may still have succeeded — but without the raw list there is
      // nothing to diff, and `available` alone cannot tell us what we're
      // missing. Say so rather than reporting a clean bill.
      unchecked.push(
        `${label} — ${result.error ?? 'adapter reported no liveIds (discovery failed, or it predates the field)'}`,
      );
      continue;
    }

    const { unlisted, stale } = catalogDrift(
      result.liveIds,
      adapter.staticCatalog().map((m) => m.id),
      aliasFor(service),
    );
    if (unlisted.length || stale.length) drift.push({ service, label, unlisted, stale });
  }

  return { checked: firstKeyByService.size, drift, skipped, unchecked };
}

/** One-line summary for a `maintenance_runs` row. Names the providers rather
 *  than only counting them — "2 providers drifted" sends you back to the logs,
 *  which for a nightly job means nobody looks. */
export function summariseModelsDrift(r: ModelsDriftResult): string {
  const parts = r.drift.map((d) => `${d.service} (+${d.unlisted.length}/-${d.stale.length})`);
  const head = parts.length
    ? `drift in ${parts.join(', ')}`
    : `no drift across ${r.checked} provider(s)`;
  return r.unchecked.length ? `${head}; ${r.unchecked.length} could not be checked` : head;
}
