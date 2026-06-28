import { NextResponse } from 'next/server';
import type { WorkflowStatusString } from '@dbos-inc/dbos-sdk';
import { getOwnerOr401 } from '@/lib/auth';
import { listRuns } from '@/lib/runners';
import { RUNNER_STATUSES } from '@/lib/runners-types';

/**
 * GET /api/runners?status=&name=&queue=&hours=&page=
 *
 * A page of runner executions (DBOS workflows), newest first. `status` repeats
 * for multi-select. Owner-gated; the DBOS system DB isn't per-user, so this is
 * an access gate, not a row filter. See lib/runners.ts.
 */
const PAGE_SIZE = 50;
const VALID_STATUSES = new Set<string>(RUNNER_STATUSES);

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);

  const statuses = url.searchParams
    .getAll('status')
    .filter((s) => VALID_STATUSES.has(s)) as WorkflowStatusString[];
  const name = url.searchParams.get('name')?.trim() || undefined;
  const queue = url.searchParams.get('queue')?.trim() || undefined;
  const hours = Number(url.searchParams.get('hours') ?? '') || 0;
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const since = hours > 0 ? new Date(Date.now() - hours * 3_600_000).toISOString() : undefined;

  const { runs, hasMore } = await listRuns({
    status: statuses.length === 1 ? statuses[0] : statuses.length > 1 ? statuses : undefined,
    name,
    queue,
    since,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  return NextResponse.json({ runs, hasMore, page, pageSize: PAGE_SIZE });
}
