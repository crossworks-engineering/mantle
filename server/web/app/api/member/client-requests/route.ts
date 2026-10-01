import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withHumanViewer } from '@mantle/db';
import type { MemberItemsPage } from '@mantle/client-types';
import { CLIENT_ITEM_KINDS } from '@mantle/client-types/member-kinds';
import { clientRequestItemRow, listClientRequests } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';

const Query = z.object({
  kind: z.enum(CLIENT_ITEM_KINDS).optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
const PAGE_SIZE = 50;

/**
 * GET /api/member/client-requests?kind=&q=&page= : what clients submitted
 * for review (client logins C5, decision 5 B), newest first, read only. Rows
 * of the one list's shape (source `client-request`, pill `submitted`, the
 * client as author). Read on the team role with the human flag on: the only
 * scope that sees them (an agent never does); a client's draft, returned or
 * accepted item never shows.
 */
export async function GET(req: Request) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid query.' }, { status: 400 });
  const { kind, q, page } = parsed.data;
  const res = await withHumanViewer('team', () =>
    listClientRequests({ kind, q, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
  );
  const body: MemberItemsPage = {
    items: res.items.map((r) => clientRequestItemRow(r.row, r.author)),
    total: res.total,
    page,
    pageSize: PAGE_SIZE,
  };
  return NextResponse.json(body);
}
