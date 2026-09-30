import { NextResponse } from '@/server/http-compat';
import { loadReaderTreeFolder } from '@mantle/content/tree';
import { getMemberOr401 } from '@/lib/auth';
import { ReaderTreeQuery, readerTreeKindOr404 } from '@/lib/tree-route';

/**
 * GET /api/member/tree/:kind?folder=&cursor=&sort=&limit= : one folder of a
 * kind as a MEMBER sees it, read only (TreeFolderPage). Items are read at the
 * team level (row security, the Library's levels); a folder shows when it
 * leads to something the member reads or its share covers them; counts are
 * the member's. A folder the member cannot see is a 404, like a missing one
 * (packages/content/src/tree/reader.ts).
 */
export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const kind = await readerTreeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const parsed = ReaderTreeQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  const page = await loadReaderTreeFolder(member.anchorId, 'team', kind, {
    folderId: parsed.data.folder ?? null,
    cursor: parsed.data.cursor,
    sort: parsed.data.sort,
    limit: parsed.data.limit,
  });
  if (!page) return NextResponse.json({ error: 'folder not found' }, { status: 404 });
  return NextResponse.json(page);
}
