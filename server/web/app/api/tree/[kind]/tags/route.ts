import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { listTreeTags } from '@mantle/content/tree';
import { treeKindOr404 } from '@/lib/tree-route';

/** GET /api/tree/:kind/tags — the tags on the kind's items, most used first
 *  (TreeTagList), for the tree's filter menu. */
export async function GET(_req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const kind = await treeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  return NextResponse.json(await listTreeTags(user.id, kind));
}
