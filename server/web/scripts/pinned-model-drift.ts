/**
 * Pinned-model drift report — are the models this brain's agents and workers
 * actually point at still real, and has the family moved on?
 *
 * WHY THIS EXISTS: a pinned model is a decision, not a subscription. It was
 * right the day it was chosen and nothing ages it. `models-drift` asks whether
 * our onboarding CATALOGUE is current and deliberately skips OpenRouter
 * ("cannot drift by construction") — true of a catalogue, false of a pin: a
 * delisted slug 404s at turn time and the first sign is a failed conversation.
 *
 *   pnpm -C server/web models:pinned          # human-readable
 *   pnpm -C server/web models:pinned --all    # also list the pins that are fine
 *   pnpm -C server/web models:pinned --json   # machine-readable
 *
 * The computation lives in `lib/maintenance/pinned-model-drift-run.ts` so the
 * nightly cron runs the same definition; this file is its terminal
 * presentation.
 *
 * Exit code is 0 even when drift is found — this reports, it does not gate. A
 * vendor shipping a newer model is not a failure, and a nightly sweep that goes
 * red on it gets muted within a week.
 */

import { runPinnedModelDrift } from '../lib/maintenance/pinned-model-drift-run';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const showAll = args.includes('--all');

  if (!process.env.DATABASE_URL) {
    console.error('pinned-model-drift: DATABASE_URL must be set');
    process.exit(1);
  }

  const r = await runPinnedModelDrift();

  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  console.log(`${r.checked} pinned model(s) across enabled agents and workers.\n`);

  console.log('── Missing (the pin is absent from a catalogue that covers it) ──');
  if (!r.missing.length) {
    console.log('  none — every checkable pin still exists');
  }
  for (const v of r.missing) {
    console.log(`  ✗ ${v.pin.ref}  ${v.pin.provider} / ${v.pin.model}`);
  }

  console.log('\n── Newer in the same family ──');
  if (!r.newerInFamily.length) {
    console.log('  none — every checkable pin is the newest of its family');
  }
  for (const v of r.newerInFamily) {
    if (v.status !== 'newer-in-family') continue;
    console.log(`  → ${v.pin.ref}  ${v.pin.model}`);
    console.log(`      newer: ${v.candidates.join(', ')}`);
  }
  if (r.newerInFamily.length) {
    // The one judgement in here that could reasonably go the other way, so it
    // is stated wherever the result is read rather than buried in the source.
    console.log(
      '\n  Version segments compare as integers (4.20 > 4.5), matching how these\n' +
        '  vendors number releases. Newer is a fact about the id, not a recommendation —\n' +
        '  changing a model is a cost and behaviour decision that stays yours.',
    );
  }

  console.log('\n── Not checked (absence of evidence, NOT a problem) ──');
  if (!r.unchecked.length) {
    console.log('  none');
  }
  for (const v of r.unchecked) {
    if (v.status !== 'unchecked') continue;
    console.log(`  ? ${v.pin.ref}  ${v.pin.provider} / ${v.pin.model}`);
    console.log(`      ${v.reason}`);
  }

  if (showAll) {
    console.log('\n── Current ──');
    for (const v of r.current) console.log(`  ✓ ${v.pin.ref}  ${v.pin.model}`);
  } else if (r.current.length) {
    console.log(`\n${r.current.length} pin(s) current — pass --all to list them.`);
  }
}

await main().catch((err) => {
  console.error('pinned-model-drift failed:', err);
  process.exit(1);
});
// Explicit, like models-drift: this reads the DB, and the pg pool keeps the
// event loop alive, so without it the CLI prints the whole report and then
// hangs forever. (The nightly cron dispatches `runPinnedModelDrift` in-process
// and is unaffected — which is exactly why the hang would only ever be seen by
// a human running it by hand.)
process.exit(0);
