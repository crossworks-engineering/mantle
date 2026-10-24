import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { loadAppNavView } from '@mantle/content';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'content' },
});

/**
 * /api/app-nav — the Apps sidebar in its original shape, for clients from
 * before the item tree (docs/folder-tree.md).
 *
 * GET returns everything that sidebar renders in one round-trip
 * (AppNavResponse), built from the tree: its folders, where each app sits,
 * this login's pins and open counts, and every app, slim. The first read of a
 * brain moves its old layout document into the tree (tree/apps-nav.ts).
 *
 * The layout is the tree's, changed through /api/tree/apps. The old save
 * (PUT), a 410 stub since the tree, went with the stubs in arch A7.
 */
export async function GET() {
  const user = ownerCaller();
  return NextResponse.json(await loadAppNavView(user.id, user.actor.id));
}
