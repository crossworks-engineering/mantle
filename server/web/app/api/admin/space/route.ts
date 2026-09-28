import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { REVIEW_STATES, type ReviewState } from '@mantle/db';
import { SPACE_ITEM_KINDS, createMineItem, listMine } from '@mantle/content';
import { adminWriter, getAdminSpaceOr401, inAdminSpace } from '@/lib/admin-space';
import { readJsonNoNul } from '@/lib/strip-nul';
import { spaceStateResponse } from '@/lib/member-space';
import { firstIssue } from '@/lib/zod-issue';

const Query = z.object({
  kind: z.enum(SPACE_ITEM_KINDS).optional(),
  q: z.string().max(200).optional(),
  // A comma list of review states: `?review=submitted,returned` (U10).
  review: z
    .string()
    .max(100)
    .transform((v) =>
      v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .refine((v) => v.every((x) => (REVIEW_STATES as readonly string[]).includes(x)), {
      message: 'unknown review state',
    })
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
const PAGE_SIZE = 50;

const Title = z.string().trim().max(200).default('');
const Create = z.discriminatedUnion('type', [
  z.object({ type: z.literal('page'), title: Title, icon: z.string().max(16).optional() }),
  z.object({ type: z.literal('note'), title: Title, content: z.string().max(200_000).optional() }),
  z.object({ type: z.literal('draw'), title: Title }),
  z.object({ type: z.literal('table'), title: Title }),
]);

/**
 * GET /api/admin/space?kind=&q=&review=&page= : the calling admin's own
 * private items, newest first; the same query and answer as
 * GET /api/member/space.
 * POST /api/admin/space { type, title, … } : a new private item ("Keep
 * private"), as POST /api/member/space.
 *
 * Member logins Phase 7 (lib/admin-space.ts). Files arrive by upload
 * (POST /api/admin/space-files). Nothing here is indexed or extracted: the
 * item is the brain's only after Accept (…/:id/accept).
 */
export async function GET(req: Request) {
  const caller = await getAdminSpaceOr401();
  if (caller instanceof Response) return caller;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid query.' }, { status: 400 });
  const { kind, q, review, page } = parsed.data;
  const res = await inAdminSpace(caller, () =>
    listMine(caller.spaceId, {
      kind,
      q,
      ...(review?.length ? { reviewStates: review as ReviewState[] } : {}),
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
  );
  return NextResponse.json({ ...res, page, pageSize: PAGE_SIZE });
}

export async function POST(req: Request) {
  const caller = await getAdminSpaceOr401();
  if (caller instanceof Response) return caller;
  const parsed = Create.safeParse(await readJsonNoNul(req));
  if (!parsed.success)
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  try {
    const item = await inAdminSpace(caller, () =>
      createMineItem(caller.spaceId, parsed.data, adminWriter(caller)),
    );
    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    return spaceStateResponse(err);
  }
}
