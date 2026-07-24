import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { countTopics, listTopics } from '@/lib/debug';

/** GET /api/debug/topics?page=&q= — conversation topics, paginated. */
const PAGE_SIZE = 25;

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const query = url.searchParams.get('q')?.trim() || undefined;
  const [topics, total] = await Promise.all([
    listTopics(user.id, { query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countTopics(user.id, { query }),
  ]);
  return NextResponse.json({ topics, total, page, pageSize: PAGE_SIZE });
}
