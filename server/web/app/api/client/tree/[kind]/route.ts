import { NextResponse } from '@/server/http-compat';
import { clientTreeFolderPage, loadReaderTreeFolder } from '@mantle/content/tree';
import { getClientOr401 } from '@/lib/auth';
import { ReaderTreeQuery, readerTreeKindOr404 } from '@/lib/tree-route';

/**
 * GET /api/client/tree/:kind?folder=&cursor=&sort=&limit= : one folder of a
 * kind as a CLIENT sees it, read only (ClientTreeFolderPage: no level, share
 * or system flag). Items are read at the client level; a folder shows when it
 * leads to something shared with clients or its share covers them; counts are
 * the client's. A folder the client cannot see is a 404, like a missing one.
 */
export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const kind = await readerTreeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const parsed = ReaderTreeQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  const page = await loadReaderTreeFolder(client.anchorId, 'client', kind, {
    folderId: parsed.data.folder ?? null,
    cursor: parsed.data.cursor,
    sort: parsed.data.sort,
    limit: parsed.data.limit,
  });
  if (!page) return NextResponse.json({ error: 'folder not found' }, { status: 404 });
  return NextResponse.json(clientTreeFolderPage(page));
}
