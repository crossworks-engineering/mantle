import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { countTraces, listTraces } from '@/lib/traces';
import type { TraceSort, TraceSortDir } from '@mantle/web-ui/traces-format';

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
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
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
  const [traces, total] = await Promise.all([
    listTraces(user.id, { ...filter, sort, dir, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countTraces(user.id, filter),
  ]);
  return NextResponse.json({ traces, total, page, pageSize: PAGE_SIZE });
}
