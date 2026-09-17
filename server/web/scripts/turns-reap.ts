/**
 * Fail assistant turns stuck in 'pending' — the CLI face of the `turns-reap`
 * maintenance sweep. The rule itself lives in lib/maintenance/turns-reap.ts so
 * the cron worker and this script share one definition.
 *
 * An outbound row is written 'pending' when a turn starts and settled only at
 * the end; a provider call that neither returns nor throws, or a runner killed
 * mid-turn, strands it forever with no error, no failed status and nothing for
 * a failure count to see — just a composer stuck on "Thinking…".
 *
 * Usage:
 *   pnpm turns:reap           # DRY RUN — report only, writes nothing
 *   pnpm turns:reap --apply   # fail the stale turns
 *
 * Idempotent: once clean, it's a no-op.
 */

import { env } from '@mantle/config';
import {
  findStalePendingTurns,
  reapStalePendingTurns,
  staleAfterMin,
} from '../lib/maintenance/turns-reap';

if (!env('DATABASE_URL')) {
  console.error('turns-reap: DATABASE_URL must be set');
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const mins = staleAfterMin();
  const stale = await findStalePendingTurns();
  if (stale.length === 0) {
    console.log(`[turns-reap] nothing stale (threshold ${mins} min) — all clean`);
    return;
  }

  const byModel = new Map<string, number>();
  for (const r of stale) {
    const key = r.model ?? '(unset)';
    byModel.set(key, (byModel.get(key) ?? 0) + 1);
  }
  console.log(
    `[turns-reap] ${stale.length} turn(s) stuck 'pending' past ${mins} min: ` +
      [...byModel.entries()].map(([m, n]) => `${m}×${n}`).join(', '),
  );
  for (const r of stale.slice(0, 10)) {
    console.log(
      `  - ${r.id} (${r.agent ?? '(no agent)'} · ${r.model ?? '(unset)'}) ` +
        `started ${r.createdAt.toISOString()}`,
    );
  }
  if (stale.length > 10) console.log(`  … and ${stale.length - 10} more`);

  if (!apply) {
    console.log('[turns-reap] DRY RUN — pass --apply to fail them');
    return;
  }
  console.log(`[turns-reap] failed ${await reapStalePendingTurns()} stale turn(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[turns-reap] failed:', err);
    process.exit(1);
  });
