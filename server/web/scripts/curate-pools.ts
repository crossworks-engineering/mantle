/**
 * Pool re-curation — rebuild the curated model shortlists from live evidence.
 *
 * WHY THIS EXISTS: the shipped pool template was curated on 2026-08-22 and
 * nothing aged it. A month later two of its 97 entries pointed at models
 * OpenRouter had delisted (so the `Free` combo picked a reflector that 404s),
 * four carried prices off by up to 5x, and seven vendors had shipped
 * auto-updating `~vendor/x-latest` aliases that no pool offered. A stale
 * shortlist looks exactly like a considered one, which is why this had to
 * become a thing you can RUN rather than a thing someone remembers to redo.
 *
 *   pnpm -C server/web models:curate            # plan only (the default)
 *   pnpm -C server/web models:curate --apply    # write it into curated_models
 *   pnpm -C server/web models:curate --export packages/client-types/src/model-pools-data.json
 *   pnpm -C server/web models:curate --json     # machine-readable plan
 *
 * `--export` writes the repo-shipped TEMPLATE, in the same shape the
 * /api/model-pools/export route emits, so a re-curation is a file swap. It
 * works with or without `--apply`: the template is the plan, and whether this
 * brain also adopts it is a separate decision.
 *
 * The computation lives in `lib/maintenance/curate-pools{,-run}.ts` so the
 * maintenance runner and the nightly cron use the SAME definition; this file
 * is the terminal presentation of it.
 *
 * Exits 0 whether or not the pools were stale. Finding drift is the job, not a
 * failure, and a sweep that goes red every time a vendor ships would be muted
 * within a week.
 */

import { writeFileSync } from 'node:fs';
import { env } from '@mantle/config';
import { resolveSingleOwnerId } from '@mantle/db';
import { runCuratePools } from '../lib/maintenance/curate-pools-run';
import { summariseCuration } from '../lib/maintenance/curate-pools';

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--')) return args[i + 1];
  const inline = args.find((a) => a.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

function money(v: number | null | undefined): string {
  if (v == null) return '   —   ';
  return `$${v.toFixed(2).padStart(6)}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const apply = args.includes('--apply');
  const exportTo = flagValue(args, '--export');

  if (!env('DATABASE_URL')) {
    console.error('curate-pools: DATABASE_URL must be set');
    process.exit(1);
  }

  const ownerId = env('ALLOWED_USER_ID') || (await resolveSingleOwnerId());
  if (apply && !ownerId) {
    console.error('curate-pools: --apply needs an owner (set ALLOWED_USER_ID)');
    process.exit(1);
  }

  const r = await runCuratePools({ apply, ownerId: ownerId ?? undefined });

  if (exportTo) {
    writeFileSync(exportTo, `${JSON.stringify(r.plan.entries, null, 2)}\n`);
  }

  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  console.log(`${summariseCuration(r.plan)}\n`);

  for (const d of r.degraded) console.log(`  ! ${d}`);
  if (r.degraded.length) console.log('');

  // Delisted first: this is breakage, not staleness. Everything else in the
  // report is a judgement call; these are entries that cannot work.
  const delisted = r.plan.pools.flatMap((p) => p.dropped.map((d) => ({ pool: p.pool, ...d })));
  console.log('── Currently curated but DELISTED (a turn on it would 404) ──');
  if (!delisted.length) console.log('  none — every curated entry still exists');
  for (const d of delisted) console.log(`  ✗ [${d.pool}] ${d.name} — ${d.model}`);

  console.log('\n── Planned shortlists ──');
  for (const p of r.plan.pools) {
    console.log(`\n  ${p.label}  (${p.pool}, ${p.entries.length})`);
    for (const e of p.entries) {
      const m = e.routes[0]?.model ?? '?';
      console.log(
        `    ${String(e.position).padStart(2)}. ${money(e.pricing?.inputPerM)} ·` +
          `${money(e.pricing?.outputPerM)}  ${'★'.repeat(e.rating ?? 0).padEnd(5)} ${m}`,
      );
    }
  }

  if (exportTo) console.log(`\nTemplate written to ${exportTo}`);

  if (apply) {
    console.log(`\nApplied: ${r.removed} row(s) replaced by ${r.written}.`);
  } else {
    console.log('\nPlan only — nothing was written. Pass --apply to adopt it on this brain.');
  }
}

await main().catch((err) => {
  console.error('curate-pools failed:', err);
  process.exit(1);
});
// Explicit, like the other DB-reading scripts: the pg pool keeps the event loop
// alive, so without this the CLI prints the whole report and then hangs.
process.exit(0);
