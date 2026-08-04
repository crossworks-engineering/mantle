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
 * the drift. Adapters now surface it as `DiscoveryResult.liveIds`.
 *
 *   pnpm -C server/web models:drift          # human-readable
 *   pnpm -C server/web models:drift --json   # machine-readable
 *
 * The computation lives in `lib/maintenance/models-drift.ts` so the nightly
 * cron runs the same definition; this file is the terminal presentation of it.
 *
 * Read-only. Exit code is 0 even when drift is found — this reports, it does
 * not gate. A provider shipping a model is not a failure, and a nightly sweep
 * that goes red on it would be muted within a week.
 */

import { runModelsDrift } from '../lib/maintenance/models-drift';

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');

  if (!process.env.DATABASE_URL) {
    console.error('models-drift: DATABASE_URL must be set');
    process.exit(1);
  }

  const { checked, drift, skipped, unchecked } = await runModelsDrift();

  if (asJson) {
    console.log(JSON.stringify({ drift, skipped, unchecked }, null, 2));
    return;
  }

  console.log(`\nChecked ${checked} provider(s) with a stored key.`);

  console.log(`\n── Catalogue drift ──`);
  if (!drift.length) {
    console.log('  none — every curated catalogue matches what its provider serves');
  }
  for (const r of drift) {
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
