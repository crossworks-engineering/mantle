/** GET /api/presents/[id]/revisions: the kept past versions of a canvas
 *  (decision 4: the last ten), newest first, without their sources. */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { listPresentRevisions } from '@/lib/presents';
import type { RouteParams } from '@/lib/route-params';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const revisions = await listPresentRevisions(user.id, id);
  if (!revisions) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ revisions });
}
