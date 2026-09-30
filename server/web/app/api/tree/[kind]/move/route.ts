import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { moveTreeItems, notifyTreeChanged } from '@mantle/content/tree';
import { firstIssue } from '@/lib/zod-issue';
import { treeErrorResponse, treeKindOr404 } from '@/lib/tree-route';

const Body = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  /** The destination folder; null = the root (unsorted). */
  folderId: z.string().uuid().nullable(),
});

/** POST /api/tree/:kind/move — move items into a folder. Each item moves on
 *  its own; `failed` lists the ones that could not (TreeMoveResult). */
export async function POST(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const kind = await treeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  try {
    const result = await moveTreeItems(user.id, kind, parsed.data.ids, parsed.data.folderId);
    if (result.moved) await notifyTreeChanged(user.id, kind);
    return NextResponse.json(result);
  } catch (err) {
    return treeErrorResponse(err);
  }
}
