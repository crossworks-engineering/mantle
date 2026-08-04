/**
 * In-process maintenance sweeps — the code behind the nightly cron worker
 * (workers/maintenance.ts) and the shared implementation of the recurring
 * hygiene tasks, so the CLI script and the cron run exactly one definition
 * of each sweep (docs/maintenance-runner.md, Phase 2).
 *
 * Cost-safety: only registry tasks with `schedulable: true` are considered, and
 * the registry asserts at load that those are free. As belt-and-braces this
 * module re-checks the cost before running anything — the cron path must never
 * be able to touch a model-spending task.
 *
 * That re-check now calls the registry's own `isFreeCost` rather than restating
 * the rule. It used to hardcode `cost === 'sql'`, and when the registry widened
 * to `sql | io` the two silently disagreed: `deps-drift` declared itself
 * schedulable, passed the registry assertion, and was dropped here on every
 * single run. It never fired once. One rule, one definition.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
import { findDuplicateCandidates, mergeEntities, type MergeCandidate } from '@mantle/content';

import { MAINTENANCE_TASKS, isFreeCost } from './registry';
import { finishRun, hasRecentCronRun, recordRunStart } from './history';
import { runDepsDrift, summariseDepsDrift } from './deps-drift';
import { runModelsDrift, summariseModelsDrift } from './models-drift';
import { summarisePinnedModelDrift } from './pinned-model-drift';
import { runPinnedModelDrift } from './pinned-model-drift-run';
import { reapAbandonedTracesAllOwners } from '../journey';

export interface EntitiesDedupeResult {
  auto: MergeCandidate[];
  review: MergeCandidate[];
  /** Merges attempted (from whichever tiers were applied). */
  attempted: number;
  merged: number;
}

/** The recurring hygiene sweep: find near-duplicate entities and merge the
 *  requested tiers (both false = dry-run). Pure DB work, no LLM. The tier
 *  flags mirror the CLI script's `--go` / `--include-review` exactly.
 *
 *  Applying takes a Postgres advisory lock so the three surfaces (CLI, UI
 *  spawn, nightly cron — different processes, so no in-process flag helps)
 *  can never merge concurrently. Concurrent same-pair merges are benign, but
 *  two interleavings are not: alias read-modify-write into the same
 *  canonical (lost update) and a candidate chain (X→P applying while P→Q
 *  deletes P) leaving edges pointing at a deleted entity — entity_edges has
 *  no FK to enforce it. try-lock: a contender fails fast with a clear error
 *  instead of queueing behind a long merge run. */
export async function runEntitiesDedupe(
  ownerId: string,
  opts: {
    applyAuto: boolean;
    applyReview?: boolean;
    /** Called with the detected candidates BEFORE any merge is attempted —
     *  the CLI prints them here so a mid-run failure still shows the list. */
    onCandidates?: (auto: MergeCandidate[], review: MergeCandidate[]) => void;
  },
): Promise<EntitiesDedupeResult> {
  const applying = opts.applyAuto || Boolean(opts.applyReview);
  if (!applying) {
    const candidates = await findDuplicateCandidates(ownerId);
    const auto = candidates.filter((c) => c.tier === 'auto');
    const review = candidates.filter((c) => c.tier === 'review');
    opts.onCandidates?.(auto, review);
    return { auto, review, attempted: 0, merged: 0 };
  }

  // The transaction exists solely to scope the advisory lock (xact locks
  // release on commit/rollback, even if the process dies mid-run). The
  // merges themselves run in their own short transactions inside
  // mergeEntities — the outer connection just holds the lock.
  return db.transaction(async (tx) => {
    const res = (await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtext('mantle:maintenance:entities-dedupe')) as locked`,
    )) as unknown;
    const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as {
      locked: boolean;
    }[];
    if (!rows[0]?.locked) {
      throw new Error(
        'another entities-dedupe run is in progress (CLI, UI, or the nightly cron) — try again when it finishes',
      );
    }

    const candidates = await findDuplicateCandidates(ownerId);
    const auto = candidates.filter((c) => c.tier === 'auto');
    const review = candidates.filter((c) => c.tier === 'review');
    opts.onCandidates?.(auto, review);

    const toApply = [...(opts.applyAuto ? auto : []), ...(opts.applyReview ? review : [])];
    let merged = 0;
    for (const c of toApply) {
      const ok = await mergeEntities(ownerId, c.canonicalId, c.dupId);
      if (ok) merged++;
    }
    return { auto, review, attempted: toApply.length, merged };
  });
}

/** In-process runners for schedulable tasks, keyed by registry slug. A
 *  schedulable task with no entry here is skipped (the cron never falls back
 *  to spawning scripts), which is why `registry.test.ts` fails the build when
 *  the two lists disagree — a missing entry is invisible at runtime beyond one
 *  console.warn nobody reads at 03:30 UTC.
 *
 *  Each returns a one-line summary for the run row. Report-style sweeps
 *  summarise their findings rather than throwing on them: a dependency
 *  publishing a patch, or a provider shipping a model, is not a failed run. */
export const SWEEPS: Record<string, (ownerId: string) => Promise<string>> = {
  'entities-dedupe': async (ownerId) => {
    const res = await runEntitiesDedupe(ownerId, { applyAuto: true });
    return `merged ${res.merged}/${res.auto.length} auto candidates (${res.review.length} left for review)`;
  },
  'deps-drift': async () => summariseDepsDrift(await runDepsDrift()),
  'models-drift': async () => summariseModelsDrift(await runModelsDrift()),
  'pinned-model-drift': async () => summarisePinnedModelDrift(await runPinnedModelDrift()),
  // All owners, unlike the owner-scoped self-heal the live-activity view runs
  // on poll — a box nobody browses is exactly the case this exists for.
  'traces-reap': async () => {
    const reaped = await reapAbandonedTracesAllOwners();
    return reaped === 0 ? 'no abandoned traces' : `reaped ${reaped} abandoned trace(s)`;
  },
};

/** Double-fire guard: skip a sweep whose last cron run (any state — a failed
 *  attempt still arms the guard, mirroring the backups scheduler) is newer
 *  than this. Protects against duplicate cron deliveries and restart loops
 *  on top of pg-boss's own once-per-slot semantics. */
const GUARD_WINDOW_MS = 20 * 60 * 60 * 1000;

/** Deadline for one sweep — parity with the UI's RUN_TIMEOUT_MS. On expiry
 *  the run row goes 'failed' but the underlying promise can't be cancelled;
 *  it may still complete in the background (merges are transactional). */
const SWEEP_TIMEOUT_MS = 30 * 60 * 1000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: timed out after ${ms / 60000} min`)),
          ms,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run every schedulable sweep once, recording each into maintenance_runs
 *  (source 'cron'). Called by the nightly pg-boss job. Per-task failures are
 *  contained — one broken sweep doesn't stop the rest. */
export async function runScheduledSweeps(ownerId: string): Promise<void> {
  for (const task of MAINTENANCE_TASKS.filter((t) => t.schedulable)) {
    if (!isFreeCost(task.cost)) continue; // belt-and-braces; see module header
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
    let summary: string | undefined;
    try {
      runId = await recordRunStart({ slug: task.slug, source: 'cron', live: true });
      summary = await withTimeout(sweep(ownerId), SWEEP_TIMEOUT_MS, task.slug);
    } catch (err) {
      console.error(`[maintenance] ${task.slug} failed:`, msg(err));
      if (runId) {
        await finishRun(runId, { state: 'failed', summary: msg(err) }).catch(() => {});
      }
      continue;
    }
    // Success path settles OUTSIDE the try above: a transient finishRun
    // failure must not re-mark a run that actually applied as 'failed'.
    console.log(`[maintenance] ${task.slug}: ${summary}`);
    if (runId) {
      await finishRun(runId, { state: 'done', exitCode: 0, summary }).catch((err) =>
        console.error(`[maintenance] ${task.slug}: done, but history update failed:`, msg(err)),
      );
    }
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
