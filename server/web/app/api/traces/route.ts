import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { countTraces, listTraces } from '@/lib/traces';
import { toolMakerFor } from '@/lib/tools';
import type { TraceSort, TraceSortDir } from '@mantle/client-types/traces-format';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/**
 * GET /api/traces?kind=&status=&hours=&sort=&dir=&page=
 *
 * The /traces list bundle: a filtered/sorted page of trace summaries plus the
 * total (for the pager). `kind` and `status` repeat for multi-select. Default
 * view (no status) is completed runs + failures. Owner-scoped.
 */
const PAGE_SIZE = 50;
const DEFAULT_STATUSES = ['success', 'error'];

export async function GET(req: Request) {
  const user = ownerCaller();
  const url = new URL(req.url);

  const kinds = url.searchParams.getAll('kind');
  const statuses = url.searchParams.getAll('status');
  const hours = Number(url.searchParams.get('hours') ?? '24') || 24;
  const sortParam = url.searchParams.get('sort');
  const sort: TraceSort = sortParam === 'cost' || sortParam === 'duration' ? sortParam : 'started';
  const dir: TraceSortDir = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);

  const filter = {
    kinds: kinds.length > 0 ? kinds : undefined,
    statuses: statuses.length > 0 ? statuses : DEFAULT_STATUSES,
    sinceHours: hours,
  };
  // Only the traces the signed-in login may read (W7 integration fix 3, L2).
  const reader = toolMakerFor(user);
  const [traces, total] = await Promise.all([
    listTraces(user.id, reader, {
      ...filter,
      sort,
      dir,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    countTraces(user.id, reader, filter),
  ]);
  return NextResponse.json({ traces, total, page, pageSize: PAGE_SIZE });
}
