import { NextResponse } from 'next/server';

import { getOwnerOr401 } from '@/lib/auth';
import { MAINTENANCE_TASKS } from '@/lib/maintenance/registry';
import { getRun } from '@/lib/maintenance/run-store';
import type { MaintenanceOverview, MaintenanceTaskInfo } from '@/lib/maintenance/types';

// Registry overview + current/last run. Read-only; runs start via ./run.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  const body: MaintenanceOverview = { tasks, run: getRun() };
  return NextResponse.json(body);
}
