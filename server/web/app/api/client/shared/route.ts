import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { LIBRARY_KINDS, listClientShared } from '@mantle/content';
import type { ClientSharedPage } from '@mantle/client-types';
import { getClientOr401 } from '@/lib/auth';

const Query = z.object({
  kind: z.enum(LIBRARY_KINDS).optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
const PAGE_SIZE = 50;

/**
 * GET /api/client/shared?kind=&q=&page= : "Shared with you", the items a
 * CLIENT may read, newest first (client logins, Phase C2). Runs at the client
 * level: Postgres row security shows client items only, so there is no filter
 * in this code to get wrong. Rows carry no author and no staff field.
 */
export async function GET(req: Request) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid query.' }, { status: 400 });
  const { kind, q, page } = parsed.data;
  const res = await withViewer('client', () =>
    listClientShared(client.anchorId, {
      kind,
      q,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
  );
  const body: ClientSharedPage = { ...res, page, pageSize: PAGE_SIZE };
  return NextResponse.json(body);
}
