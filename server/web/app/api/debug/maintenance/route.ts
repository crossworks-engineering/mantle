import { NextResponse } from '@/server/http-compat';

import { getOwnerOr401 } from '@/lib/auth';
import { listRecentRuns, reapStaleRuns } from '@/lib/maintenance/history';
import { MAINTENANCE_TASKS } from '@/lib/maintenance/registry';
import { getRun } from '@/lib/maintenance/run-store';
import type {
  MaintenanceOverview,
  MaintenanceTaskInfo,
  RunHistoryEntry,
  RunState,
} from '@mantle/web-ui/types/maintenance';

// Registry overview + current/last run. Read-only; runs start via ./run.

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const tasks: MaintenanceTaskInfo[] = MAINTENANCE_TASKS.map((t) => ({
    slug: t.slug,
    title: t.title,
    description: t.description,
    kind: t.kind,
    status: t.status,
    cost: t.cost,
    schedulable: t.schedulable,
    supportsDryRun: Boolean(t.applyFlag || t.dryRunFlag),
    uiRunnable: !t.positionalArgs?.length,
    missingEnv: (t.requiresEnv ?? []).filter((k) => !process.env[k]),
    notes: t.notes,
  }));

  // History is best-effort: on a DB that hasn't run migration 0128 yet the
  // task list should still render (the table is additive, not load-bearing).
  let history: RunHistoryEntry[] = [];
  try {
    await reapStaleRuns(); // settle rows orphaned by dead processes first
    history = (await listRecentRuns(20)).map((r) => ({
      id: r.id,
      slug: r.slug,
      source: r.source as RunHistoryEntry['source'],
      live: r.live,
      state: r.state as RunState,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      exitCode: r.exitCode,
      summary: r.summary,
    }));
  } catch (err) {
    console.error('[maintenance] history read failed:', err);
  }

  const body: MaintenanceOverview = { tasks, run: getRun(), history };
  return NextResponse.json(body);
}
