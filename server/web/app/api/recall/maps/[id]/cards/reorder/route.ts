import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { reorderRecallCards } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { recallWriteFailure } from '@/lib/recall';
import { firstIssue } from '@/lib/zod-issue';
import { UUID_RE } from '@mantle/std';

/** Drag-to-reorder: the whole card order, by slug. The entry card keeps its
 *  place at the top whatever is sent — a walk starts there. */
const Body = z.object({
  slugs: z.array(z.string().min(1)).min(1),
  version: z.number().int().nonnegative(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  try {
    const res = await reorderRecallCards(
      user.id,
      id,
      parsed.data.slugs,
      { kind: 'owner', id: user.actor.id, name: user.actor.displayName ?? null },
      parsed.data.version,
    );
    return NextResponse.json(res);
  } catch (err) {
    return recallWriteFailure(err);
  }
}
