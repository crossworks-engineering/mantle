import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { TREE_SORTS } from '@mantle/client-types/tree';
import { loadTreeFolder } from '@mantle/content/tree';
import { ensureTreeRoot, privateRootItems, treeKindOr404 } from '@/lib/tree-route';

const Query = z.object({
  folder: z.string().uuid().optional(),
  cursor: z.string().max(500).optional(),
  sort: z.enum(TREE_SORTS).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

/** GET /api/tree/:kind?folder=&cursor=&sort=&limit= — one folder's page: its
 *  subfolders and one page of its items (TreeFolderPage). No folder is the
 *  root, where the caller's own private items come first. */
export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const kind = await treeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  await ensureTreeRoot(user.id, kind, user.actor.id);
  const page = await loadTreeFolder(user.id, kind, {
    folderId: parsed.data.folder ?? null,
    cursor: parsed.data.cursor,
    sort: parsed.data.sort,
    limit: parsed.data.limit,
  });
  if (!page) return NextResponse.json({ error: 'folder not found' }, { status: 404 });
  if (!page.folder && !parsed.data.cursor) {
    page.items = [...(await privateRootItems(user, kind)), ...page.items];
  }
  return NextResponse.json(page);
}
