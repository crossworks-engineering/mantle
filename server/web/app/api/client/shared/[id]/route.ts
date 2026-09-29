import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { getClientSharedItem } from '@mantle/content';
import { getClientOr401 } from '@/lib/auth';

const Params = z.object({ id: z.string().uuid() });
/** A table's tab id (from the item's `tabs` list); absent = the first tab. */
const Query = z.object({ tab: z.string().min(1).max(200).optional() });

/**
 * GET /api/client/shared/:id[?tab=] : one item a CLIENT may read, with its
 * body (client logins, Phase C2): a page's published doc, a note's text, a
 * table's committed grid for the chosen tab, a file's metadata. Read at the
 * client level: an item above it is a plain 404, the same answer as an id
 * that does not exist. A page or note comes with every reference to an item
 * the client may not read taken out (plan N6): a mention chip or a link reads
 * "Private item" and points nowhere, an embed of such an item is left out.
 * A malformed id is a 400 before anything is read.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const query = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return NextResponse.json({ error: 'Invalid tab.' }, { status: 400 });
  const tabId = query.data.tab;
  const item = await withViewer('client', () =>
    getClientSharedItem(client.anchorId, params.data.id, tabId ? { tabId } : {}),
  );
  if (!item) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ item });
}
