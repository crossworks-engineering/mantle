import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { REVIEW_STATES, type ReviewState } from '@mantle/db';
import { SPACE_ITEM_KINDS, createMineItem, listMine } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import { readJsonNoNul } from '@/lib/strip-nul';
import { inMySpace, memberWriteGate, spaceStateResponse } from '@/lib/member-space';
import { firstIssue } from '@/lib/zod-issue';
import { memberFilingPath } from '@mantle/content/tree';
import { memberTreeScope, treeErrorResponse } from '@/lib/tree-route';

const Query = z.object({
  kind: z.enum(SPACE_ITEM_KINDS).optional(),
  q: z.string().max(200).optional(),
  // A comma list of review states: `?review=submitted,returned` (U10), and
  // `with-admin` for the items an admin has taken over (audit F07).
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
      {
        message: 'unknown review state',
      },
    )
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
const PAGE_SIZE = 50;

const Title = z.string().trim().max(200).default('');
/** A folder the member's tree shows, to file the new draft in (folder plan
 *  phase 5). Pages have no tree yet. */
const FolderId = z.string().uuid().nullable().optional();
const Create = z.discriminatedUnion('type', [
  z.object({ type: z.literal('page'), title: Title, icon: z.string().max(16).optional() }),
  z.object({
    type: z.literal('note'),
    title: Title,
    content: z.string().max(200_000).optional(),
    folderId: FolderId,
  }),
  z.object({ type: z.literal('draw'), title: Title, folderId: FolderId }),
  z.object({ type: z.literal('table'), title: Title, folderId: FolderId }),
]);
const TREE_KIND_OF = { note: 'notes', draw: 'draw', table: 'tables' } as const;

/**
 * GET /api/member/space?kind=&q=&review=&page= : the member's own items
 * ("Mine"), newest first, with sharing and review state; `review` is a comma
 * list of review states (unknown = 400). Page 1 also lists the member's items
 * an admin has taken over (audit F07) as `with-admin` rows, title and kind
 * only, before the own rows (`total` counts them); `review=` without
 * `with-admin` leaves them out.
 * POST /api/member/space { type, title, folderId?, … } : a new private draft
 * item, filed in `folderId` (a folder the member's tree shows) when given.
 *
 * Member logins Phase 2. Pages, notes, drawings and tables; files arrive by
 * upload (POST /api/member/space-files).
 */
export async function GET(req: Request) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid query.' }, { status: 400 });
  const { kind, q, review, page } = parsed.data;
  const res = await inMySpace(member, () =>
    listMine(member.spaceId, {
      kind,
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
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const limited = memberWriteGate(member);
  if (limited) return limited;
  const parsed = Create.safeParse(await readJsonNoNul(req));
  if (!parsed.success)
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  const { folderId, ...input } =
    parsed.data.type === 'page' ? { ...parsed.data, folderId: null } : parsed.data;
  let path: string | undefined;
  if (folderId && input.type !== 'page') {
    try {
      path = await memberFilingPath(memberTreeScope(member), TREE_KIND_OF[input.type], folderId);
    } catch (err) {
      return treeErrorResponse(err);
    }
  }
  try {
    const item = await inMySpace(member, () => createMineItem(member.spaceId, input, {}, { path }));
    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    return spaceStateResponse(err);
  }
}
