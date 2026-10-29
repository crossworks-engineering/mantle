/**
 * Remove the old store revisions no row points at: the CLI face of the `store-sweep` maintenance sweep. Old
 * revisions a flip left and stages whose flip never landed, of items whose
 * row names another file; only once unreferenced on two runs a grace period
 * (an hour) apart and older than it. Files of items with no row, and table
 * drafts of the old `<node>.draft.sqlite` form, are reported, never removed. The rule lives in
 * @mantle/content/store-sweep (sweepStores), shared by the cron worker and
 * this script. File removal and one read of the rows: no model, no
 * extraction.
 *
 * Usage:
 *   pnpm store:sweep                        # DRY RUN: counts only, removes nothing
 *   pnpm store:sweep --apply                # remove them
 *   pnpm store:sweep --allow-many           # DRY RUN past a restore's hold
 *                                           # (.store-sweep-hold) or a row back on
 *                                           # an older revision: read this first
 *   pnpm store:sweep --apply --allow-many   # then remove them
 *
 * Each run removes at most the larger of 500 files and half a store, the
 * oldest marked first; the rest wait for the next run ("deferred"). The dry
 * run lists what it keeps: files with no row, files of an item whose row's
 * file is missing, and old-form table drafts (`<node>.draft.sqlite`, kept
 * for ever: check no row names one, then remove it by hand).
 *
 * Leftovers: what a run only reports (an item's file with no row and no
 * tombstone; an old-form table draft) is
 * never removed by the sweep. After reviewing it, an operator removes it:
 *   pnpm store:sweep --report-orphans [list-file]   # write the list (stdout without a file)
 *   pnpm store:sweep --remove-orphans list-file     # DRY RUN of that list
 *   pnpm store:sweep --remove-orphans list-file --apply
 * Edit the list down to what may go first. Each listed file goes only while
 * the stores still report it as a leftover and once it is an hour old;
 * never while a restore's hold is on any store (exit 2), and never a file
 * of a store whose rows name no file at all (a wrong or empty database).
 *
 * Exit codes: 0 done (a store a restore holds says HELD) · 1 crash · 2 a
 * hard stop (nothing removed there; the line says why: a row outside the
 * root, no row naming any file, a row back on an older revision).
 */
import { env } from '@mantle/config';
import { closeDb } from '@mantle/db';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  parseLeftovers,
  removeLeftovers,
  reportedLeftovers,
  StoreHeldError,
  summariseStoreSweep,
  sweepStores,
} from '@mantle/content/store-sweep';

if (!env('DATABASE_URL')) {
  console.error('store-sweep: DATABASE_URL must be set');
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const allowMany = args.includes('--allow-many');

/** The value after `flag`, unless it is another flag. */
function valueOf(flag: string): string | undefined {
  const i = args.indexOf(flag);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
}

async function main() {
  if (args.includes('--report-orphans')) {
    const list = await reportedLeftovers();
    const text =
      '# store leftovers (reported, never removed by the sweep): <store part>\t<path>\n' +
      '# review; delete the lines that must stay; then --remove-orphans <this file>\n' +
      list.map((l) => `${l.label}\t${l.rel}`).join('\n') +
      '\n';
    const out = valueOf('--report-orphans');
    if (out) {
      writeFileSync(out, text);
      console.log(`[store-sweep] ${list.length} leftovers listed in ${out}`);
    } else process.stdout.write(text);
    return;
  }
  if (args.includes('--remove-orphans')) {
    const file = valueOf('--remove-orphans');
    if (!file) throw new Error('--remove-orphans needs the reviewed list file');
    let r: Awaited<ReturnType<typeof removeLeftovers>>;
    try {
      r = await removeLeftovers(parseLeftovers(readFileSync(file, 'utf8')), { apply });
    } catch (err) {
      if (!(err instanceof StoreHeldError)) throw err;
      console.error(`[store-sweep] ${err.message}`);
      process.exitCode = 2;
      return;
    }
    for (const l of r.removed)
      console.log(`  ${apply ? 'removed' : 'would remove'}: ${l.label} ${l.rel}`);
    for (const l of r.skipped) console.log(`  kept (${l.why}): ${l.label} ${l.rel}`);
    console.log(
      `[store-sweep] leftovers: ${r.removed.length} ${apply ? 'removed' : 'would go (dry run: add --apply)'}, ${r.skipped.length} kept`,
    );
    return;
  }
  const r = await sweepStores({ dryRun: !apply, allowMany });
  console.log(`[store-sweep] ${summariseStoreSweep(r, !apply)}`);
  for (const s of r) {
    for (const f of s.noRow) console.log(`  kept, no row: ${s.label} ${f}`);
    for (const f of s.rowFileMissing)
      console.log(`  kept, a row's file is missing: ${s.label} ${f}`);
    for (const f of s.legacy) console.log(`  kept, a draft from before A3b: ${s.label} ${f}`);
  }
  if (r.some((s) => s.aborted)) process.exitCode = 2;
}

main()
  .then(async () => {
    await closeDb().catch(() => {});
    process.exit(process.exitCode ?? 0);
  })
  .catch((err) => {
    console.error('[store-sweep] failed:', err);
    process.exit(1);
  });
