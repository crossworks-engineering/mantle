import { NextResponse } from '@/server/http-compat';
import { searchReaderTree } from '@mantle/content/tree';
import { getMemberOr401 } from '@/lib/auth';
import { ReaderTreeSearchQuery, readerTreeKindOr404 } from '@/lib/tree-route';

/** GET /api/member/tree/:kind/search?q=&cursor= : the folders a MEMBER sees
 *  and the items they read, by name, each with where it lives
 *  (TreeSearchResult). An empty `q` lists every item by name, no folders. */
export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const kind = await readerTreeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const parsed = ReaderTreeSearchQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  return NextResponse.json(
    await searchReaderTree(member.anchorId, 'team', kind, parsed.data.q, {
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    }),
  );
}
