import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { countDigests, listDigests } from '@/lib/debug';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/** GET /api/debug/digests?page=&q= — conversation digests, paginated. */
const PAGE_SIZE = 25;

export async function GET(req: Request) {
  const user = ownerCaller();
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const query = url.searchParams.get('q')?.trim() || undefined;
  const [digests, total] = await Promise.all([
    listDigests(user.id, { query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countDigests(user.id, { query }),
  ]);
  return NextResponse.json({ digests, total, page, pageSize: PAGE_SIZE });
}
