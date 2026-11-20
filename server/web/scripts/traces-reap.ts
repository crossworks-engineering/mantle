/**
 * Reap abandoned traces for EVERY owner — the cron-schedulable twin of
 * journey.ts's reapAbandonedTraces (which is owner-scoped and only fires when
 * someone opens the live-activity view). On a box nobody browses for days,
 * crashed-mid-run traces sat in `running` the whole time, skewing every
 * "active"/"running" rollup until the next UI visit finally swept them
 * (a client box 2026-07-18: two traces reaped ~41 h late). This sweep closes them
 * on the nightly cadence instead.
 *
 * Same rule and the same write as the in-app reaper (journey.ts
 * abandonedTraceSql, reapAbandonedTracesAllOwners): status → error
 * 'abandoned…', finished_at = now, duration_ms = NULL (the true duration is
 * unknowable — never fabricate it from the reap time). Threshold:
 * the longer of MANTLE_EXTRACT_EXPIRE_MIN (default 60) and 720 (the most a
 * saved base budget may be) + 15, and for a book read's traces
 * (`data.lane` 'book') the book lane's longest budget + 15, so a long-but-live
 * extract run is never false-flagged.
 *
 * Usage:
 *   pnpm traces:reap           # DRY RUN — report only, writes nothing
 *   pnpm traces:reap --apply   # close the stale traces
 *
 * Pure SQL, idempotent: once clean, it's a no-op.
 */

import { closeDb } from '@mantle/db';
import { listAbandonedTraces, reapAbandonedTracesAllOwners } from '../lib/journey';

const apply = process.argv.slice(2).includes('--apply');

async function main() {
  const stale = await listAbandonedTraces();
  if (stale.length === 0) {
    console.log('[traces-reap] nothing stale: all clean');
    return;
  }
  const byKind = new Map<string, number>();
  for (const r of stale) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  console.log(
    `[traces-reap] ${stale.length} trace(s) stuck 'running' past their budget: ` +
      [...byKind.entries()].map(([k, n]) => `${k}×${n}`).join(', '),
  );
  for (const r of stale.slice(0, 10)) {
    console.log(`  - ${r.id} (${r.kind}) started ${new Date(r.startedAt).toISOString()}`);
  }
  if (stale.length > 10) console.log(`  … and ${stale.length - 10} more`);

  if (!apply) {
    console.log('[traces-reap] DRY RUN — pass --apply to close them');
    return;
  }
  console.log(`[traces-reap] closed ${await reapAbandonedTracesAllOwners()} trace(s)`);
}

main()
  .then(() => closeDb().catch(() => {}))
  .catch(async (err) => {
    console.error('[traces-reap] failed:', err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
