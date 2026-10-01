import { NextResponse } from '@/server/http-compat';
import { clientTreeSearch, searchReaderTree } from '@mantle/content/tree';
import { getClientOr401 } from '@/lib/auth';
import { ReaderTreeSearchQuery, readerTreeKindOr404 } from '@/lib/tree-route';

/** GET /api/client/tree/:kind/search?q=&cursor= : the folders a CLIENT sees
 *  and the items shared with them, by name, each with where it lives
 *  (ClientTreeSearchResult: no level). An empty `q` lists every item by
 *  name, no folders. */
export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const kind = await readerTreeKindOr404(ctx);
  if (kind instanceof Response) return kind;
  const parsed = ReaderTreeSearchQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  return NextResponse.json(
    clientTreeSearch(
      await searchReaderTree(client.anchorId, 'client', kind, parsed.data.q, {
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
      }),
    ),
  );
}
