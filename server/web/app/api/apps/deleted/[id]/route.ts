/**
 * DELETE /api/apps/deleted/[id] — delete a deleted app for good, now: its
 * history and snapshot files. 404 when it is not in the trash. A Moderator
 * of its home (the guard); an app a login other than the brain's owner
 * deleted, the brain's owner only (403, CEO decision 1).
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { AppTrashRefusedError, purgeDeletedApp } from '@mantle/content/app-trash';

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  let ok: boolean;
  try {
    ok = await purgeDeletedApp(user.id, id, { byOwner: user.actor.isOwner });
  } catch (err) {
    if (err instanceof AppTrashRefusedError) {
      return NextResponse.json(
        {
          error: 'forbidden',
          reason: 'item-workspace',
          message: 'Only the brain owner deletes this app for good.',
        },
        { status: 403 },
      );
    }
    throw err;
  }
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
