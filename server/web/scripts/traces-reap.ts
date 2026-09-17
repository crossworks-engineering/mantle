/**
 * Reap abandoned traces for EVERY owner — the cron-schedulable twin of
 * journey.ts's reapAbandonedTraces (which is owner-scoped and only fires when
 * someone opens the live-activity view). On a box nobody browses for days,
 * crashed-mid-run traces sat in `running` the whole time, skewing every
 * "active"/"running" rollup until the next UI visit finally swept them
 * (NATREF 2026-07-18: two traces reaped ~41 h late). This sweep closes them
 * on the nightly cadence instead.
 *
 * Same semantics as the in-app reaper: status → error 'abandoned…',
 * finished_at = now, duration_ms = NULL (the true duration is unknowable —
 * never fabricate it from the reap time). Threshold mirrors journey.ts:
 * MANTLE_EXTRACT_EXPIRE_MIN (default 60) + 15, so a long-but-live extract run
 * is never false-flagged.
 *
 * Usage:
 *   pnpm traces:reap           # DRY RUN — report only, writes nothing
 *   pnpm traces:reap --apply   # close the stale traces
 *
 * Pure SQL, idempotent: once clean, it's a no-op.
 */

import postgres from 'postgres';
import { env } from '@mantle/config';

const DATABASE_URL = env('DATABASE_URL');
if (!DATABASE_URL) {
  console.error('traces-reap: DATABASE_URL must be set');
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');
const ABANDON_AFTER_MIN = (Number(env('MANTLE_EXTRACT_EXPIRE_MIN')) || 60) + 15;

async function main() {
  const sql = postgres(DATABASE_URL!, { max: 1 });
  try {
    const stale = await sql`
      SELECT id, kind::text AS kind, started_at
      FROM traces
      WHERE status = 'running' AND started_at < now() - make_interval(mins => ${ABANDON_AFTER_MIN})
      ORDER BY started_at
    `;
    if (stale.length === 0) {
      console.log(`[traces-reap] nothing stale (threshold ${ABANDON_AFTER_MIN} min) — all clean`);
      return;
    }
    const byKind = new Map<string, number>();
    for (const r of stale) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
    console.log(
      `[traces-reap] ${stale.length} trace(s) stuck 'running' past ${ABANDON_AFTER_MIN} min: ` +
        [...byKind.entries()].map(([k, n]) => `${k}×${n}`).join(', '),
    );
    for (const r of stale.slice(0, 10)) {
      console.log(`  - ${r.id} (${r.kind}) started ${new Date(r.started_at).toISOString()}`);
    }
    if (stale.length > 10) console.log(`  … and ${stale.length - 10} more`);

    if (!apply) {
      console.log('[traces-reap] DRY RUN — pass --apply to close them');
      return;
    }
    const closed = await sql`
      UPDATE traces
      SET status = 'error',
          error = ${'abandoned — no completion after ' + ABANDON_AFTER_MIN + ' min (the process likely restarted or crashed mid-run; swept by maintenance)'},
          finished_at = now(),
          duration_ms = NULL
      WHERE status = 'running' AND started_at < now() - make_interval(mins => ${ABANDON_AFTER_MIN})
      RETURNING id
    `;
    console.log(`[traces-reap] closed ${closed.length} trace(s)`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('[traces-reap] failed:', err);
  process.exit(1);
});
