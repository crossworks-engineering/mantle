import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { TREE_SORTS } from '@mantle/client-types/tree';
import { loadTreeFolder } from '@mantle/content/tree';
import { ensureTreeRoot, privateRootItems, treeKindOr404 } from '@/lib/tree-route';
import { parseWsFilter, withChips, workspaceChips } from '@/lib/list-workspaces';

const Query = z.object({
  folder: z.string().uuid().optional(),
  cursor: z.string().max(500).optional(),
  sort: z.enum(TREE_SORTS).optional(),
  limit: z.coerce.number().int().positive().optional(),
  // Checked by parseWsFilter.
  ws: z.string().optional(),
});

/** GET /api/tree/:kind?folder=&cursor=&sort=&limit=&ws=: one folder's page:
 *  its subfolders and one page of its items (TreeFolderPage), each with its
 *  workspaces and link pill. No folder is the root, where the caller's own
 *  private items come first. `ws` keeps only the items that workspace reads
 *  (no private items) and is echoed back. */
export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const user = ownerCaller();
  const kind = await treeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  const ws = await parseWsFilter(req, user.id, user.actor.id);
  if (ws instanceof Response) return ws;
  await ensureTreeRoot(user.id, kind, user.actor.id);
  const page = await loadTreeFolder(user.id, kind, {
    folderId: parsed.data.folder ?? null,
    cursor: parsed.data.cursor,
    sort: parsed.data.sort,
    limit: parsed.data.limit,
    ws: ws ?? undefined,
  });
  if (!page) return NextResponse.json({ error: 'folder not found' }, { status: 404 });
  if (!page.folder && !parsed.data.cursor && !ws) {
    page.items = [...(await privateRootItems(user, kind)), ...page.items];
  }
  const chips = await workspaceChips(user.id, user.actor.id, [
    ...(page.folder ? [page.folder.id] : []),
    ...page.folders.map((f) => f.id),
    ...page.items.map((i) => i.id),
  ]);
  return NextResponse.json({
    ...page,
    folder: page.folder ? withChips([page.folder], chips)[0]! : null,
    folders: withChips(page.folders, chips),
    items: withChips(page.items, chips),
    ...(ws ? { ws } : {}),
  });
}
