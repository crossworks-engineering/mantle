import { NextResponse } from '@/server/http-compat';
import { restoreRecallRevision } from '@mantle/content';
import { ownerCaller } from '@/lib/auth';
import { recallActorOf } from '@/lib/recall';
import { UUID_RE } from '@mantle/std';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
});

/**
 * Undo: put one revision's BEFORE state back.
 *
 * A restore is itself a write, so it runs every check. Restoring a card whose
 * body is now over budget, or whose options point at cards since deleted, is
 * refused with the same teaching error as any other write rather than quietly
 * reinstating a map that no longer holds together.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const res = await restoreRecallRevision(user.id, id, await recallActorOf(user));
  return NextResponse.json(res);
}
