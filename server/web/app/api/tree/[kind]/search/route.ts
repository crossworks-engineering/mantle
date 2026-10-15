import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { TREE_SEARCH_MAX, TREE_TAG_MAX } from '@mantle/client-types/tree';
import { searchTree } from '@mantle/content/tree';
import { treeKindOr404 } from '@/lib/tree-route';
import { hitWorkspaces, parseReadCover, withChips, workspaceChips } from '@/lib/list-workspaces';

const Query = z.object({
  q: z.string().trim().max(TREE_SEARCH_MAX).default(''),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().positive().optional(),
  tag: z.string().trim().min(1).max(TREE_TAG_MAX).optional(),
  // Checked by parseReadCover.
  ws: z.string().optional(),
  across: z.string().optional(),
});

/** GET /api/tree/:kind/search?q=&cursor=&ws=&tag=&across=: matching
 *  folders, then items, each with the crumbs of where it lives, its
 *  workspaces and link pill (TreeSearchResult). An empty or missing `q`
 *  lists every item by name (the A to Z view), no folders. `ws` and `tag`
 *  (TreeFilter) narrow the items; a filtered search has no folders. `ws` is
 *  echoed back. `across=1` with a term (task f26a516e): every workspace the
 *  caller reads, `ws`'s items first, each item with the workspace it opens
 *  in (`workspace`); `across` is echoed. */
export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const user = ownerCaller();
  const kind = await treeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  // The cover is the one decision (narrow or order, and the empty-term
  // rule); the search takes it as is.
  const cover = await parseReadCover(req, user.id, user.actor.id, 'search', parsed.data.q);
  if (cover instanceof Response) return cover;
  const ws = cover.current;
  const found = await searchTree(user.id, kind, parsed.data.q, {
    cursor: parsed.data.cursor,
    limit: parsed.data.limit,
    tag: parsed.data.tag,
    cover,
  });
  const [chips, hits] = await Promise.all([
    workspaceChips(user.id, user.actor.id, [
      ...found.folders.map((f) => f.id),
      ...found.items.map((i) => i.id),
    ]),
    found.across
      ? hitWorkspaces(
          user.id,
          user.actor.id,
          found.items.map((i) => i.id),
          ws,
        )
      : null,
  ]);
  const items = withChips(found.items, chips).map((i) => {
    const hit = hits?.get(i.id);
    return hit ? { ...i, workspace: hit } : i;
  });
  return NextResponse.json({
    ...found,
    folders: withChips(found.folders, chips),
    items,
    ...(ws ? { ws } : {}),
  });
}
