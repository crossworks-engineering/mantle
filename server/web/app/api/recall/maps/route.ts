import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { countRecallMaps, listRecallMaps } from '@/lib/recall';

const PAGE_SIZE = 20;

/** The Recall catalog: every map + its compile state, failed compiles
 *  included. URL-driven search + pagination (`q` / `page`) like the other
 *  list APIs; `total`/`page`/`pageSize` ride along for the client pager. */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim() || undefined;
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const [maps, total] = await Promise.all([
    listRecallMaps(user.id, { q, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countRecallMaps(user.id, q),
  ]);
  return NextResponse.json({ maps, total, page, pageSize: PAGE_SIZE });
}
