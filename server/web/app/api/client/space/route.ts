import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { REVIEW_STATES, type ReviewState } from '@mantle/db';
import { CLIENT_ITEM_KINDS } from '@mantle/client-types/member-kinds';
import { createMineItem, listMine } from '@mantle/content';
import { getClientOr401 } from '@/lib/auth';
import { readJsonNoNul } from '@/lib/strip-nul';
import { clientNoteTooLarge, clientWriteGate, inMyClientSpace } from '@/lib/client-space';
import { spaceStateResponse } from '@/lib/member-space';
import { firstIssue } from '@/lib/zod-issue';

const Query = z.object({
  kind: z.enum(CLIENT_ITEM_KINDS).optional(),
  q: z.string().max(200).optional(),
  // A comma list of review states, and `with-admin` for the items a
  // reviewer took over (as the member list).
  review: z
    .string()
    .max(100)
    .transform((v) =>
      v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .refine(
      (v) => v.every((x) => x === 'with-admin' || (REVIEW_STATES as readonly string[]).includes(x)),
      { message: 'unknown review state' },
    )
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
const PAGE_SIZE = 50;

const Title = z.string().trim().max(200).default('');
/** A client writes pages and notes; files arrive by upload. No drawings, no
 *  tables (CLIENT_ITEM_KINDS). */
const Create = z.discriminatedUnion('type', [
  z.object({ type: z.literal('page'), title: Title, icon: z.string().max(16).optional() }),
  z.object({ type: z.literal('note'), title: Title, content: z.string().max(200_000).optional() }),
]);

/**
 * GET /api/client/space?kind=&q=&review=&page= : the CLIENT's own items,
 * newest first, with their review state (client logins C5). `kind` is page,
 * note or file (anything else is a 400); without it only those kinds are
 * listed. Page 1 also lists the client's items a reviewer took over, as
 * `with-admin` rows (title and kind only), as on the member list.
 * POST /api/client/space { type: page | note, title, … } : a new private
 * draft (a drawing or a table is a 400). The client's limits apply (500
 * items, and the text counts toward the 200 MB: 409 `quota`; a note over
 * 50,000 characters: 400 `too-large`).
 */
export async function GET(req: Request) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid query.' }, { status: 400 });
  const { kind, q, review, page } = parsed.data;
  const res = await inMyClientSpace(client, () =>
    listMine(client.spaceId, {
      kind,
      kinds: CLIENT_ITEM_KINDS,
      q,
      ...(review?.length ? { reviewStates: review as (ReviewState | 'with-admin')[] } : {}),
      withAdmin: true,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
  );
  return NextResponse.json({ ...res, page, pageSize: PAGE_SIZE });
}

export async function POST(req: Request) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const limited = clientWriteGate(client);
  if (limited) return limited;
  const parsed = Create.safeParse(await readJsonNoNul(req));
  if (!parsed.success)
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  if (parsed.data.type === 'note') {
    const big = clientNoteTooLarge(parsed.data.content);
    if (big) return big;
  }
  try {
    const item = await inMyClientSpace(client, () => createMineItem(client.spaceId, parsed.data));
    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    return spaceStateResponse(err);
  }
}
