import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';

/**
 * DEPRECATED (folder phase 7): pages do not nest, so a page never has pages
 * under it and deleting one takes nothing else with it. Always `{ count: 0
 * }`, kept so a client from before the pages tree (which asks before a
 * delete) keeps working.
 */
export async function GET(_req: Request, _ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json({ count: 0 });
}
