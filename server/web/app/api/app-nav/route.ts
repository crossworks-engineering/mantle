import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { APP_NAV_LAYOUT_RETIRED, loadAppNavView } from '@mantle/content';

/**
 * /api/app-nav — the Apps sidebar in its original shape, for clients from
 * before the item tree (docs/folder-tree.md).
 *
 * GET returns everything that sidebar renders in one round-trip
 * (AppNavResponse), built from the tree: its folders, where each app sits,
 * this login's pins and open counts, and every app, slim. The first read of a
 * brain moves its old layout document into the tree (tree/apps-nav.ts).
 *
 * PUT used to save the layout document. The layout is the tree's now and is
 * changed through /api/tree/apps, so a save is refused (410) with a message
 * an older client can show, rather than written somewhere nothing reads.
 */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json(await loadAppNavView(user.id, user.actor.id));
}

export async function PUT() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json({ error: APP_NAV_LAYOUT_RETIRED }, { status: 410 });
}
