import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { recordItemOpened } from '@mantle/content/tree';

/** POST /api/tree/items/:id/opened — count one open of an item by this login
 *  (Recent and Most used). 404 when it is not one of the brain's tree items. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const id = z
    .string()
    .uuid()
    .safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const ok = await recordItemOpened(user.id, user.actor.id, id.data);
  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: 'not found' }, { status: 404 });
}
