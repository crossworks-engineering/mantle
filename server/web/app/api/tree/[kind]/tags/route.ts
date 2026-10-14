import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { listTreeTags } from '@mantle/content/tree';
import { treeKindOr404 } from '@/lib/tree-route';
import { parseWsFilter } from '@/lib/list-workspaces';

/** GET /api/tree/:kind/tags?ws= — the tags on the kind's items, most used
 *  first (TreeTagList), for the tree's filter menu. `ws` counts only the
 *  items that workspace reads, as the tree does, and is echoed back. */
export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const user = ownerCaller();
  const kind = await treeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const ws = await parseWsFilter(req, user.id, user.actor.id);
  if (ws instanceof Response) return ws;
  const tags = await listTreeTags(user.id, kind, ws ?? undefined);
  return NextResponse.json({ ...tags, ...(ws ? { ws } : {}) });
}
