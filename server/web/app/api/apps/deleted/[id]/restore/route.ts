/**
 * POST /api/apps/deleted/[id]/restore — bring a deleted app back with its id,
 * code, name, look and data (apps first-class plan, Phase 3). It returns
 * admin-only in Unsorted; its sharing does not come back. Who may: a
 * Moderator of its last home, or the brain's owner for an app with no home
 * stored (mantle_app_trash_act, plan v3.2 S6 c2: the check, and the
 * snapshot it comes back from); else, or not in the trash, the one 404.
 * The app comes back in the login's scope. 409 when its last snapshot
 * holds no code. The same 404 when the snapshot went between the check and
 * the restore (a purge; the restore checks again where the app is made).
 */
import { NextResponse } from '@/server/http-compat';
import { UUID_RE } from '@mantle/std';
import { ownerCaller } from '@/lib/auth';
import { adminAppTrashAct } from '@mantle/content';
import { restoreDeletedAppFrom } from '@mantle/content/app-trash';
import { itemNotFound } from '@/lib/auth/item-answers';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'content',
    item: {
      none: 'a deleted app (Recently deleted), no live item: mantle_app_trash_act asks its manage right',
    },
  },
});

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return itemNotFound();
  const act = await adminAppTrashAct(user.actor.id, id, 'restore');
  if (act.outcome !== 'restore') return itemNotFound();
  // AppTrashRefusedError answers 409 by the one table (A10 part 2).
  const app = await restoreDeletedAppFrom(user.id, id, act.row, { actor: 'owner' });
  if (!app) return itemNotFound();
  return NextResponse.json({ app });
}
