import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { listPendingCalls } from '@mantle/tools';
import { getOwnerOr401 } from '@/lib/auth';

const ListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const parsed = ListQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  }
  const rows = await listPendingCalls(user.id, parsed.data);
  return NextResponse.json({ pending: rows });
}
