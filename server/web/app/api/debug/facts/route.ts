import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { countFacts, listFacts } from '@/lib/debug';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/** GET /api/debug/facts?page=&q= — extracted profile facts, paginated. */
const PAGE_SIZE = 50;

export async function GET(req: Request) {
  const user = ownerCaller();
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const query = url.searchParams.get('q')?.trim() || undefined;
  const [facts, total] = await Promise.all([
    listFacts(user.id, { query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countFacts(user.id, { query }),
  ]);
  return NextResponse.json({ facts, total, page, pageSize: PAGE_SIZE });
}
