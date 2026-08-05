/**
 * Dependency drift report — how far behind our declared ranges have drifted.
 *
 * WHY THIS EXISTS: a caret range is permission, not a mechanism. `@openrouter/sdk`
 * sat at 1.0.0 for 46 releases while its manifest said `^1.0.0` the whole time,
 * because nothing ever ran an update and nothing ever said so. Declaring a range
 * and never resolving it looks identical to being current.
 *
 * Read-only and free: it reads local package.json files and the public npm
 * registry. It never writes, never installs, and never touches the database.
 *
 *   pnpm -C server/web deps:drift            # in-range drift only (the actionable set)
 *   pnpm -C server/web deps:drift --majors   # also list out-of-range majors
 *   pnpm -C server/web deps:drift --json     # machine-readable
 *
 * The computation lives in `lib/maintenance/deps-drift.ts` so the nightly cron
 * runs the same definition — the cron dispatches in-process and never spawns
 * scripts, so logic that lives only here cannot be scheduled. This file is the
 * terminal presentation of it.
 *
 * Exit code is 0 even when drift is found — this reports, it does not gate. A
 * non-zero exit would make the nightly sweep look like a failure every time a
 * dependency published a patch.
 */

import { runDepsDrift } from '../lib/maintenance/deps-drift';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wantMajors = args.includes('--majors');
  const asJson = args.includes('--json');

  if (!asJson) console.log(`Checking the workspace against the npm registry…`);
  const { checked, inRangeDrift, majors, unknown } = await runDepsDrift();

  if (asJson) {
    console.log(JSON.stringify({ inRangeDrift, majors, unknown }, null, 2));
    return;
  }

  console.log(`${checked} distinct packages checked.`);
  console.log(`\n── In-range drift (a plain \`pnpm update\` would take these) ──`);
  if (!inRangeDrift.length)
    console.log('  none — every range is resolved to its newest in-range version');
  for (const d of [...inRangeDrift].sort((a, b) => a.pkg.localeCompare(b.pkg))) {
    console.log(
      `  ${d.pkg.padEnd(34)} ${d.range.padEnd(12)} → ${d.inRange}   [${d.from.join(', ')}]`,
    );
  }

  if (wantMajors) {
    console.log(`\n── Majors outside the declared range (a deliberate migration) ──`);
    if (!majors.length) console.log('  none');
    for (const d of [...majors].sort((a, b) => a.pkg.localeCompare(b.pkg))) {
      console.log(
        `  ${d.pkg.padEnd(34)} ${d.range.padEnd(12)} → ${d.latest}   [${d.from.join(', ')}]`,
      );
    }
  } else if (majors.length) {
    console.log(
      `\n  (${majors.length} package(s) have a major outside the range — re-run with --majors)`,
    );
  }

  if (unknown.length) {
    console.log(`\n── Not checked ──`);
    for (const u of [...unknown].sort()) console.log(`  ${u}`);
  }
  console.log('');
}

await main();
