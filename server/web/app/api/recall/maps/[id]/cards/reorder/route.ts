import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { reorderRecallCards } from '@mantle/content';
import { ownerCaller } from '@/lib/auth';
import { recallActorOf, recallWriteFailure } from '@/lib/recall';
import { UUID_RE } from '@mantle/std';
import { readBody } from '@/lib/read-body';

/** Drag-to-reorder: the whole card order, by slug. The entry card keeps its
 *  place at the top whatever is sent — a walk starts there. */
const Body = z.object({
  slugs: z.array(z.string().min(1)).min(1),
  version: z.number().int().nonnegative(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const body = await readBody(req, Body);
  try {
    const res = await reorderRecallCards(
      user.id,
      id,
      body.slugs,
      await recallActorOf(user),
      body.version,
    );
    return NextResponse.json(res);
  } catch (err) {
    return recallWriteFailure(err);
  }
}
