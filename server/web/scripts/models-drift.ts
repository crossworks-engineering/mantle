/**
 * Model-catalogue drift report — what our providers serve that we don't list,
 * and what we list that they no longer serve.
 *
 * WHY THIS EXISTS: a static catalogue is a snapshot, and nothing ages it. xAI
 * shipped grok-4.5; our dropdown never mentioned it, and no test, log or error
 * could have said so — the model simply wasn't offered, which looks exactly
 * like a model that doesn't exist. It was found by reading @ai-sdk/xai's model
 * union by hand, which is not a process.
 *
 * The signal was already being computed and thrown away. `discoverModels`
 * intersects the provider's live list against our catalogue and returns only
 * the overlap; the non-overlap — their models that aren't ours — is precisely
 * the drift. Adapters now surface it as `DiscoveryResult.liveIds` and this
 * reads it.
 *
 * Only the adapters that CURATE a catalogue and filter it can drift. Copilot,
 * OpenRouter and local build their list from whatever the provider reports, so
 * they are self-updating by construction and are skipped here rather than
 * reported as clean.
 *
 *   pnpm -C server/web models:drift          # human-readable
 *   pnpm -C server/web models:drift --json   # machine-readable
 *
 * Read-only: decrypts stored keys to authenticate the list calls, calls each
 * provider's models endpoint, writes nothing. Exit code is 0 even when drift is
 * found — this reports, it does not gate. A provider shipping a model is not a
 * failure, and a nightly sweep that goes red on it would be muted within a week.
 */

import { db, apiKeys } from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import { catalogDrift, getChatAdapter, getProvider } from '@mantle/voice';

/** Providers whose catalogue is a fallback, not a curated list — their
 *  discovery builds `available` from the live response, so "drift" is not a
 *  thing that can happen to them. */
const SELF_UPDATING = new Set(['openrouter', 'copilot', 'local', 'custom']);

/**
 * Anthropic's Models API returns dated snapshot ids while our catalogue holds
 * the alias. Without this every snapshot reads as a brand-new model forever,
 * and a report that is never clean is a report nobody opens.
 */
function aliasFor(service: string): ((liveId: string) => string | undefined) | undefined {
  if (service !== 'anthropic') return undefined;
  return (liveId) => {
    const m = /^(.*)-\d{8}$/.exec(liveId);
    return m ? m[1] : undefined;
  };
}

type Report = {
  service: string;
  label: string;
  unlisted: string[];
  stale: string[];
};

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');

  if (!process.env.DATABASE_URL) {
    console.error('models-drift: DATABASE_URL must be set');
    process.exit(1);
  }

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

  const reports: Report[] = [];
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

    const result = await adapter.discoverModels(apiKey);
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
    if (unlisted.length || stale.length) reports.push({ service, label, unlisted, stale });
  }

  if (asJson) {
    console.log(JSON.stringify({ drift: reports, skipped, unchecked }, null, 2));
    return;
  }

  console.log(`\nChecked ${firstKeyByService.size} provider(s) with a stored key.`);

  console.log(`\n── Catalogue drift ──`);
  if (!reports.length) {
    console.log('  none — every curated catalogue matches what its provider serves');
  }
  for (const r of reports) {
    console.log(`\n  ${r.label} (${r.service})`);
    if (r.unlisted.length) {
      console.log(`    they serve, we don't list (add to packages/voice/src/catalogs/):`);
      for (const id of r.unlisted) console.log(`      + ${id}`);
    }
    if (r.stale.length) {
      console.log(`    we list, they no longer serve (picking one would fail):`);
      for (const id of r.stale) console.log(`      - ${id}`);
    }
  }

  if (skipped.length) {
    console.log(`\n── Not applicable ──`);
    for (const s of skipped) console.log(`  ${s}`);
  }
  if (unchecked.length) {
    console.log(`\n── Could not check ──`);
    for (const u of unchecked) console.log(`  ${u}`);
  }
  console.log('');
}

await main();
process.exit(0);
