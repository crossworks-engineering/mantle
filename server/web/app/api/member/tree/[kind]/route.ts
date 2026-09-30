import { NextResponse } from '@/server/http-compat';
import { loadMemberTreeFolder } from '@mantle/content/tree';
import { getMemberOr401 } from '@/lib/auth';
import { ReaderTreeQuery, memberTreeScope, readerTreeKindOr404 } from '@/lib/tree-route';

/**
 * GET /api/member/tree/:kind?folder=&cursor=&sort=&limit= : one folder of a
 * kind as a MEMBER sees it (TreeFolderPage). Brain items are read at the
 * team level (row security, the Library's levels); the member's own folders
 * (`own`) and drafts, and teammates' shared drafts, are merged in per path,
 * the drafts first on the first page (`source`, `state`, `author`). A folder
 * shows when it leads to something the member reads, its share covers them,
 * or it is the member's own; counts are the member's. A folder the member
 * cannot see is a 404, like a missing one
 * (packages/content/src/tree/member-tree.ts).
 */
export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const kind = await readerTreeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const parsed = ReaderTreeQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  const page = await loadMemberTreeFolder(memberTreeScope(member), kind, {
    folderId: parsed.data.folder ?? null,
    cursor: parsed.data.cursor,
    sort: parsed.data.sort,
    limit: parsed.data.limit,
  });
  if (!page) return NextResponse.json({ error: 'folder not found' }, { status: 404 });
  return NextResponse.json(page);
}
