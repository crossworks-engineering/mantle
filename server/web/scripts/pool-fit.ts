/**
 * Pool-fit report — does every model this brain records actually do the job
 * its pool (or worker kind) needs?
 *
 * WHY THIS EXISTS: "Read images" and "Image generation" both accept image
 * input, so the input side alone cannot tell a reader from a generator. On
 * 2026-09-02 an image generator was sitting in the vision pool on every brain.
 * Four write paths now refuse that (docs/model-pools.md), but a guard only
 * protects the NEXT write — this finds what predates it.
 *
 *   pnpm -C server/web models:pool-fit          # human-readable
 *   pnpm -C server/web models:pool-fit --all    # also list what is fine
 *   pnpm -C server/web models:pool-fit --json   # machine-readable
 *
 * The computation lives in `lib/maintenance/pool-fit-run.ts` so the nightly
 * cron runs the same definition; this file is its terminal presentation.
 *
 * Exit code is 0 even when a misfit is found. This reports, it does not gate:
 * removing a curated entry is the owner's call, and repointing a live worker
 * is a cost decision.
 */

import { runPoolFit } from '../lib/maintenance/pool-fit-run';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const showAll = args.includes('--all');

  if (!process.env.DATABASE_URL) {
    console.error('pool-fit: DATABASE_URL must be set');
    process.exit(1);
  }

  const r = await runPoolFit();

  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  console.log(`${r.checked} OpenRouter-routed model(s) across pools, agents and workers.\n`);

  console.log("── Misfits (the model cannot do the pool's job) ──");
  if (!r.misfits.length) {
    console.log('  none — every checkable model fits its pool');
  }
  for (const v of r.misfits) {
    if (v.status !== 'misfit') continue;
    const where = v.subject.source === 'pool' ? 'pool entry' : `LIVE ${v.subject.source}`;
    console.log(`  ✗ [${v.subject.pool}] ${v.subject.label}  (${where})`);
    console.log(`      ${v.subject.model}`);
    console.log(`      ${v.reason}`);
  }
  if (r.misfits.some((v) => v.subject.source === 'pool')) {
    console.log('\n  Pool entries: remove at /models/pools, or with `model_pool_remove`.');
  }
  if (r.misfits.some((v) => v.subject.source !== 'pool')) {
    console.log(
      '  Live rows: repoint at /settings/ai-workers — that is a cost decision, so it stays yours.',
    );
  }

  console.log('\n── Not checked (absence of evidence, NOT a problem) ──');
  if (!r.unchecked.length) {
    console.log('  none');
  }
  for (const v of r.unchecked) {
    if (v.status !== 'unchecked') continue;
    console.log(`  ? [${v.subject.pool}] ${v.subject.label}  ${v.subject.model}`);
    console.log(`      ${v.reason}`);
  }

  if (showAll) {
    console.log('\n── Fits ──');
    for (const v of r.fits) {
      console.log(`  ✓ [${v.subject.pool}] ${v.subject.label}  ${v.subject.model}`);
    }
  } else if (r.fits.length) {
    console.log(`\n${r.fits.length} model(s) fit — pass --all to list them.`);
  }
}

await main().catch((err) => {
  console.error('pool-fit failed:', err);
  process.exit(1);
});
// Explicit, like the other drift reports: this reads the DB, and the pg pool
// keeps the event loop alive, so without it the CLI prints the report and
// then hangs forever.
process.exit(0);
