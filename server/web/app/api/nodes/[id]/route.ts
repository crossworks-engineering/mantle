import { NextResponse } from '@/server/http-compat';
import { getOwnedNode } from '@mantle/content';
import { cappedOne } from '@/lib/list-workspaces';
import { ownerCaller } from '@/lib/auth';
import { olderSummaryOf } from '@mantle/db';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner' },
});

/** One owner-scoped node's id + type — the type-blind resolver behind the
 *  `/n/<id>` permalink. 404 (not 403) for a leaked id so existence doesn't leak.
 *  Carries `olderSummary` when the W2 mark set one aside (workspaces plan 5.3). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const node = await getOwnedNode(user.id, id);
  if (!node) return NextResponse.json({ error: 'Node not found.' }, { status: 404 });
  // Admin only (the owner session): the summary the W2 mark set aside
  // (0247), labelled, for the item detail. Lists and search never carry it.
  const olderSummary = await olderSummaryOf(node.id);
  return NextResponse.json({
    node: await cappedOne(node),
    ...(olderSummary ? { olderSummary } : {}),
  });
}
