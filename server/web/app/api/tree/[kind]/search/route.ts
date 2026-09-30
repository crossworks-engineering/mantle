import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { TREE_SEARCH_MAX } from '@mantle/client-types/tree';
import { searchTree } from '@mantle/content/tree';
import { treeKindOr404 } from '@/lib/tree-route';

const Query = z.object({
  q: z.string().trim().min(1).max(TREE_SEARCH_MAX),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

/** GET /api/tree/:kind/search?q=&cursor= — matching folders, then items, each
 *  with the crumbs of where it lives (TreeSearchResult). */
export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const kind = await treeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  return NextResponse.json(
    await searchTree(user.id, kind, parsed.data.q, {
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    }),
  );
}
