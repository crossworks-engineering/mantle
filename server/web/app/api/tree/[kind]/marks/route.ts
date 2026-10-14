import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { TREE_MARK_VIEWS } from '@mantle/client-types/tree';
import { listTreeMarks } from '@mantle/content/tree';
import { ensureTreeRoot, treeKindOr404 } from '@/lib/tree-route';
import { chipped } from '@/lib/list-workspaces';

const Query = z.object({ view: z.enum(TREE_MARK_VIEWS) });

/** GET /api/tree/:kind/marks?view=pinned|recent|used — this login's pinned,
 *  recently opened or most used items of the kind (TreeMarkList), each with
 *  its workspaces and link pill. */
export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const user = ownerCaller();
  const kind = await treeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  await ensureTreeRoot(user.id, kind, user.actor.id);
  const marks = await listTreeMarks(user.id, user.actor.id, kind, parsed.data.view);
  return NextResponse.json({
    ...marks,
    items: await chipped(user.id, user.actor.id, marks.items),
  });
}
