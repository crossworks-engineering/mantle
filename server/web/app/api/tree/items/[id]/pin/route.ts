import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { TREE_PINS_MAX } from '@mantle/client-types/tree';
import { setItemPinned } from '@mantle/content/tree';

const Body = z.object({ pinned: z.boolean() });

/** PUT /api/tree/items/:id/pin — pin or unpin an item for this login; at most
 *  TREE_PINS_MAX per kind (409 beyond). */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const id = z
    .string()
    .uuid()
    .safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: 'pinned is required' }, { status: 400 });
  const res = await setItemPinned(user.id, user.actor.id, id.data, body.data.pinned);
  if (res.ok) return NextResponse.json({ ok: true });
  return res.reason === 'not-found'
    ? NextResponse.json({ error: 'not found' }, { status: 404 })
    : NextResponse.json({ error: `at most ${TREE_PINS_MAX} pins per kind` }, { status: 409 });
}
