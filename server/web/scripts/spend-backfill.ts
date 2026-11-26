/**
 * Price the stored $0 model-call steps at today's list price: the CLI face
 * of lib/maintenance/spend-backfill.ts (read its header first). Free: SQL
 * only, no model, no provider call.
 *
 * Usage:
 *   pnpm maintain spend-backfill                    # DRY RUN: numbers only
 *   pnpm maintain spend-backfill --apply            # write the prices
 *   pnpm maintain spend-backfill --undo             # DRY RUN of the undo
 *   pnpm maintain spend-backfill --undo --apply     # take them out again
 *
 * Bounds, for every mode: --since=<date> --until=<date> (the step's start,
 * UTC; `until` is not included) --model=<id> (the exact id on the step).
 * --batch=<n> sets the steps per transaction (1000 by default, 5000 at most).
 *
 * Prints counts, provider ids and model ids only (safe on a client box).
 */
import { errorMessage } from '@mantle/std';
import { closeDb } from '@mantle/db';
import {
  DEFAULT_BATCH,
  reportLines,
  runSpendBackfill,
  type Bounds,
} from '../lib/maintenance/spend-backfill';

const TAG = '[spend-backfill]';
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const undo = argv.includes('--undo');
const flag = (name: string) =>
  argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
    .trim();

/** A date flag: `2026-11-01` (00:00 UTC) or a full instant. */
function dateFlag(name: string): Date | undefined {
  const raw = flag(name);
  if (!raw) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
  if (Number.isNaN(d.getTime())) throw new Error(`--${name}: not a date (use 2026-11-01)`);
  return d;
}

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(4)}`;

async function main(): Promise<number> {
  const model = flag('model');
  const bounds: Bounds = {
    since: dateFlag('since'),
    until: dateFlag('until'),
    ...(model ? { model } : {}),
  };
  const batch = Number(flag('batch') ?? DEFAULT_BATCH);
  if (!Number.isInteger(batch) || batch < 1) throw new Error('--batch: a whole number above 0');
  const say = (line: string) => console.log(`${TAG} ${line}`);

  say(
    `${apply ? 'LIVE' : 'DRY RUN: nothing is changed'}; mode: ${undo ? 'undo' : 'price'}; ` +
      `since ${bounds.since?.toISOString() ?? 'the start'}; ` +
      `until ${bounds.until?.toISOString() ?? 'now'}; model ${bounds.model ?? 'all'}`,
  );
  say(
    'A backfilled cost is the LIST PRICE of the stored token counts by the current price ' +
      'rules. It is not the billed cost.',
  );
  if (!undo) say('Steps of a trace that closed less than an hour ago are left for a later run.');

  const { tally, written } = await runSpendBackfill({
    mode: undo ? 'undo' : 'price',
    apply,
    bounds,
    batch,
    onBatch: (done) => say(`... ${done.steps} steps written, ${usd(done.microUsd)}`),
  });
  const verb = undo ? (apply ? 'undone' : 'to undo') : apply ? 'priced' : 'to price';
  for (const line of reportLines(tally, verb)) say(line);
  if (apply) {
    say(
      `written: ${written.steps} steps, ${usd(written.microUsd)}; trace updates ` +
        `${written.traces}; run item updates ${written.runItems}; run updates ${written.runs}`,
    );
  } else if (tally.price.size > 0) {
    say(`DRY RUN: pass --apply to ${undo ? 'undo them' : 'write these prices'}`);
  }
  return 0;
}

main()
  .then(async (code) => {
    await closeDb().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(`${TAG} failed:`, errorMessage(err));
    await closeDb().catch(() => {});
    process.exit(1);
  });
