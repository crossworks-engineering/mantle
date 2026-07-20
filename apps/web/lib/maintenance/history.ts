/**
 * Unified maintenance run history over the `maintenance_runs` table
 * (migration 0128) — written by all three surfaces (CLI / UI / cron) and
 * read by the Maintenance tab and the cron due-check. Thin drizzle wrappers;
 * callers own error handling (the CLI and run-store record best-effort, the
 * cron guard treats a read failure as "not due").
 */
import { desc, eq, and, gte } from 'drizzle-orm';
import { db, maintenanceRuns, type MaintenanceRunRow } from '@mantle/db';

import type { RunState } from './types';

export type RunSource = 'cli' | 'ui' | 'cron';

export async function recordRunStart(input: {
  slug: string;
  source: RunSource;
  live: boolean;
}): Promise<string> {
  const [row] = await db
    .insert(maintenanceRuns)
    .values({ slug: input.slug, source: input.source, live: input.live, state: 'running' })
    .returning({ id: maintenanceRuns.id });
  return row!.id;
}

export async function finishRun(
  id: string,
  outcome: { state: Exclude<RunState, 'running'>; exitCode?: number | null; summary?: string },
): Promise<void> {
  await db
    .update(maintenanceRuns)
    .set({
      state: outcome.state,
      exitCode: outcome.exitCode ?? null,
      summary: outcome.summary?.slice(0, 2000) ?? null,
      finishedAt: new Date(),
    })
    .where(eq(maintenanceRuns.id, id));
}

export async function listRecentRuns(limit = 20): Promise<MaintenanceRunRow[]> {
  return db
    .select()
    .from(maintenanceRuns)
    .orderBy(desc(maintenanceRuns.startedAt))
    .limit(Math.min(Math.max(limit, 1), 100));
}

/** True when the slug has a cron-sourced run (any state — a failed attempt
 *  still arms the guard, mirroring the backups scheduler) newer than
 *  `withinMs`. The nightly sweep's double-fire guard. */
export async function hasRecentCronRun(slug: string, withinMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - withinMs);
  const rows = await db
    .select({ id: maintenanceRuns.id })
    .from(maintenanceRuns)
    .where(
      and(
        eq(maintenanceRuns.slug, slug),
        eq(maintenanceRuns.source, 'cron'),
        gte(maintenanceRuns.startedAt, cutoff),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
