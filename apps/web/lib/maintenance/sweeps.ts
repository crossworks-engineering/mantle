/**
 * In-process maintenance sweeps — the code behind the nightly cron worker
 * (workers/maintenance.ts) and the shared implementation of the recurring
 * hygiene tasks, so the CLI script and the cron run exactly one definition
 * of each sweep (docs/maintenance-runner.md, Phase 2).
 *
 * Cost-safety: only registry tasks with `schedulable: true` are considered,
 * and the registry asserts at load that those are pure SQL. As belt-and-braces
 * this module re-checks `cost === 'sql'` before running anything — the cron
 * path must never be able to touch a model-spending task.
 */
import { findDuplicateCandidates, mergeEntities, type MergeCandidate } from '@mantle/content';

import { MAINTENANCE_TASKS } from './registry';
import { finishRun, hasRecentCronRun, recordRunStart } from './history';

export interface EntitiesDedupeResult {
  auto: MergeCandidate[];
  review: MergeCandidate[];
  /** Merges attempted (from whichever tiers were applied). */
  attempted: number;
  merged: number;
}

/** The recurring hygiene sweep: find near-duplicate entities and merge the
 *  requested tiers (both false = dry-run). Pure DB work, no LLM. The tier
 *  flags mirror the CLI script's `--go` / `--include-review` exactly. */
export async function runEntitiesDedupe(
  ownerId: string,
  opts: { applyAuto: boolean; applyReview?: boolean },
): Promise<EntitiesDedupeResult> {
  const candidates = await findDuplicateCandidates(ownerId);
  const auto = candidates.filter((c) => c.tier === 'auto');
  const review = candidates.filter((c) => c.tier === 'review');

  const toApply = [...(opts.applyAuto ? auto : []), ...(opts.applyReview ? review : [])];
  let merged = 0;
  for (const c of toApply) {
    const ok = await mergeEntities(ownerId, c.canonicalId, c.dupId);
    if (ok) merged++;
  }
  return { auto, review, attempted: toApply.length, merged };
}

/** In-process runners for schedulable tasks, keyed by registry slug. A
 *  schedulable task with no entry here is skipped (the cron never falls back
 *  to spawning scripts). Each returns a one-line summary for the run row. */
const SWEEPS: Record<string, (ownerId: string) => Promise<string>> = {
  'entities-dedupe': async (ownerId) => {
    const res = await runEntitiesDedupe(ownerId, { applyAuto: true });
    return `merged ${res.merged}/${res.auto.length} auto candidates (${res.review.length} left for review)`;
  },
};

/** Double-fire guard: skip a sweep whose last cron run (any state — a failed
 *  attempt still arms the guard, mirroring the backups scheduler) is newer
 *  than this. Protects against duplicate cron deliveries and restart loops
 *  on top of pg-boss's own once-per-slot semantics. */
const GUARD_WINDOW_MS = 20 * 60 * 60 * 1000;

/** Run every schedulable sweep once, recording each into maintenance_runs
 *  (source 'cron'). Called by the nightly pg-boss job. Per-task failures are
 *  contained — one broken sweep doesn't stop the rest. */
export async function runScheduledSweeps(ownerId: string): Promise<void> {
  for (const task of MAINTENANCE_TASKS.filter((t) => t.schedulable)) {
    if (task.cost !== 'sql') continue; // belt-and-braces; see module header
    const sweep = SWEEPS[task.slug];
    if (!sweep) {
      console.warn(
        `[maintenance] schedulable task "${task.slug}" has no in-process sweep — skipped`,
      );
      continue;
    }

    try {
      if (await hasRecentCronRun(task.slug, GUARD_WINDOW_MS)) {
        console.log(`[maintenance] ${task.slug}: ran recently — skipped`);
        continue;
      }
    } catch (err) {
      // Can't read the guard — treat as not due rather than risk double-firing.
      console.error('[maintenance] cron guard read failed:', msg(err));
      continue;
    }

    let runId: string | null = null;
    try {
      runId = await recordRunStart({ slug: task.slug, source: 'cron', live: true });
      const summary = await sweep(ownerId);
      await finishRun(runId, { state: 'done', exitCode: 0, summary });
      console.log(`[maintenance] ${task.slug}: ${summary}`);
    } catch (err) {
      console.error(`[maintenance] ${task.slug} failed:`, msg(err));
      if (runId) {
        await finishRun(runId, { state: 'failed', summary: msg(err) }).catch(() => {});
      }
    }
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
