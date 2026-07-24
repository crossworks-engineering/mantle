import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { countContextTurns, listContextTurns } from '@/lib/debug';

/** GET /api/debug/context?page=&q= — per-turn retrieval audit (question ·
 *  context sent · response), paginated. */
const PAGE_SIZE = 15;

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const query = url.searchParams.get('q')?.trim() || undefined;
  const [turns, total] = await Promise.all([
    listContextTurns(user.id, { query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countContextTurns(user.id, { query }),
  ]);
  return NextResponse.json({ turns, total, page, pageSize: PAGE_SIZE });
}
