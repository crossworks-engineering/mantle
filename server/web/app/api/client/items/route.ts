import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import type { ClientItemRow, ClientItemsPage } from '@mantle/client-types';
import { CLIENT_ITEM_FILTERS, CLIENT_ITEM_KINDS } from '@mantle/client-types/member-kinds';
import {
  MEMBER_ITEMS_MAX_PAGE,
  clientAcceptedItemRow,
  clientItemsPlan,
  clientOwnItemRow,
  listAccepted,
  listMine,
  listWithAdmin,
  mergeNewestFirst,
  type PagedSource,
  type SpaceItemRow,
} from '@mantle/content';
import { getClientOr401 } from '@/lib/auth';
import { inMyClientSpace } from '@/lib/client-space';

const Query = z.object({
  kind: z.enum(CLIENT_ITEM_KINDS).optional(),
  q: z.string().max(200).optional(),
  state: z.enum(CLIENT_ITEM_FILTERS).default('all'),
  page: z.coerce.number().int().min(1).max(MEMBER_ITEMS_MAX_PAGE).default(1),
});
const PAGE_SIZE = 50;

/**
 * GET /api/client/items?kind=&q=&state=&page= : "My requests", everything
 * this CLIENT wrote, in ONE list, newest first (client logins C5): their own
 * items (a draft, submitted, returned), the ones a reviewer took over
 * (`with-admin`), and the ones an admin accepted. Each row names its
 * `source` and wears its `pill`; `state` narrows by pill
 * (CLIENT_ITEM_FILTERS). Kinds: page, note, file. Every source reads under
 * its own rules, exactly as its own route does (the client's space; the
 * author rule on the admin pool for taken and accepted items); this route
 * only merges them. No row carries a level or a staff name.
 */
export async function GET(req: Request) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid query.' }, { status: 400 });
  const { kind, q, state, page } = parsed.data;
  const plan = clientItemsPlan(state);
  const kinds = CLIENT_ITEM_KINDS;
  const sources: PagedSource<ClientItemRow>[] = [];

  const own = plan.own;
  if (own) {
    sources.push(async (limit, offset) => {
      const res = await inMyClientSpace(client, () =>
        listMine(client.spaceId, { kind, kinds, q, ...own, limit, offset }),
      );
      return { items: res.items.map(clientOwnItemRow), total: res.total };
    });
  }
  if (plan.withAdmin) {
    // Title and kind only, at most 200 (listWithAdmin): read once, sliced.
    let held: SpaceItemRow[] | null = null;
    sources.push(async (limit, offset) => {
      held ??= await inMyClientSpace(client, () =>
        listWithAdmin(client.loginId, { kind, kinds, q }),
      );
      return {
        items: held.slice(offset, offset + limit).map(clientOwnItemRow),
        total: held.length,
      };
    });
  }
  if (plan.accepted) {
    sources.push(async (limit, offset) => {
      const res = await listAccepted(client.anchorId, client.loginId, {
        kind,
        kinds,
        q,
        order: 'updated',
        limit,
        offset,
      });
      return { items: res.items.map(clientAcceptedItemRow), total: res.total };
    });
  }

  const merged = await mergeNewestFirst(sources, page, PAGE_SIZE);
  const body: ClientItemsPage = {
    items: merged.items,
    total: merged.total,
    page,
    pageSize: PAGE_SIZE,
  };
  return NextResponse.json(body);
}
