/**
 * DELETE /api/apps/deleted/[id] — delete a deleted app for good, now: its
 * history and snapshot files. 404 when it is not in the trash. Owner only.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { purgeDeletedApp } from '@mantle/content/app-trash';

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const ok = await purgeDeletedApp(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
