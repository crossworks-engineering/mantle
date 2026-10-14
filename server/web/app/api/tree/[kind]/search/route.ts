import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { TREE_SEARCH_MAX, TREE_TAG_MAX } from '@mantle/client-types/tree';
import { searchTree } from '@mantle/content/tree';
import { treeKindOr404 } from '@/lib/tree-route';
import { parseWsFilter, withChips, workspaceChips } from '@/lib/list-workspaces';

const Query = z.object({
  q: z.string().trim().max(TREE_SEARCH_MAX).default(''),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().positive().optional(),
  tag: z.string().trim().min(1).max(TREE_TAG_MAX).optional(),
  // Checked by parseWsFilter.
  ws: z.string().optional(),
});

/** GET /api/tree/:kind/search?q=&cursor=&ws=&tag=: matching folders, then
 *  items, each with the crumbs of where it lives, its workspaces and link
 *  pill (TreeSearchResult). An empty or missing `q` lists every item by name
 *  (the A to Z view), no folders. `ws` and `tag` (TreeFilter) narrow the
 *  items; a filtered search has no folders. `ws` is echoed back. */
export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const user = ownerCaller();
  const kind = await treeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  const ws = await parseWsFilter(req, user.id, user.actor.id);
  if (ws instanceof Response) return ws;
  const found = await searchTree(user.id, kind, parsed.data.q, {
    cursor: parsed.data.cursor,
    limit: parsed.data.limit,
    ws: ws ?? undefined,
    tag: parsed.data.tag,
  });
  const chips = await workspaceChips(user.id, user.actor.id, [
    ...found.folders.map((f) => f.id),
    ...found.items.map((i) => i.id),
  ]);
  return NextResponse.json({
    ...found,
    folders: withChips(found.folders, chips),
    items: withChips(found.items, chips),
    ...(ws ? { ws } : {}),
  });
}
