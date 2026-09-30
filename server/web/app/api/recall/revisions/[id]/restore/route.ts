import { NextResponse } from '@/server/http-compat';
import { restoreRecallRevision } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { recallWriteFailure } from '@/lib/recall';
import { UUID_RE } from '@mantle/std';

/**
 * Undo: put one revision's BEFORE state back.
 *
 * A restore is itself a write, so it runs every check. Restoring a card whose
 * body is now over budget, or whose options point at cards since deleted, is
 * refused with the same teaching error as any other write rather than quietly
 * reinstating a map that no longer holds together.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    const res = await restoreRecallRevision(user.id, id, {
      kind: 'owner',
      id: user.actor.id,
      name: user.actor.displayName ?? null,
    });
    return NextResponse.json(res);
  } catch (err) {
    return recallWriteFailure(err);
  }
}
