/**
 * DELETE /api/apps/deleted/[id] — delete a deleted app for good, now: its
 * history rows, and so its snapshot files (the store sweep's, a grace
 * period later). Who may: a Moderator of its last home, or the brain's
 * owner for an app with no home stored; an app a login other than the
 * brain's owner deleted, the brain's owner only (403, CEO decision 1).
 * Not in the trash, or in it where the login may not manage it: the one
 * 404. The check and the rows are the trash's definer's
 * (mantle_app_trash_act, plan v3.2 S6 c2), asked as the login.
 */
import { NextResponse } from '@/server/http-compat';
import { UUID_RE } from '@mantle/std';
import { ownerCaller } from '@/lib/auth';
import { adminAppTrashAct } from '@mantle/content';
import { itemNotFound } from '@/lib/auth/item-answers';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  DELETE: {
    class: 'content',
    item: {
      none: 'a deleted app (Recently deleted), no live item: mantle_app_trash_act asks its manage right',
    },
  },
});

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return itemNotFound();
  const act = await adminAppTrashAct(user.actor.id, id, 'purge');
  if (act.outcome === 'held') {
    return NextResponse.json(
      {
        error: 'forbidden',
        reason: 'item-workspace',
        message:
          'This app was deleted by someone other than the brain owner: only the owner deletes it for good.',
      },
      { status: 403 },
    );
  }
  if (act.outcome !== 'purged') return itemNotFound();
  return NextResponse.json({ ok: true });
}
