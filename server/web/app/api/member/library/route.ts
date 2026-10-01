import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { LIBRARY_KINDS, acceptedAuthors, listLibrary } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';

const Query = z.object({
  kind: z.enum(LIBRARY_KINDS).optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
const PAGE_SIZE = 50;

/**
 * GET /api/member/library?kind=&q=&page= : the items a MEMBER may read,
 * newest first (member logins, Phase 1). Runs at the team level: Postgres row
 * security decides what exists, so there is no filter in this code to get
 * wrong. An item a member wrote and an admin accepted carries its `author`
 * (the member-authored badge; Phase 4), read on the admin pool for exactly
 * the ids the team level returned.
 */
export async function GET(req: Request) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid query.' }, { status: 400 });
  const { kind, q, page } = parsed.data;
  const res = await withViewer('team', () =>
    listLibrary(member.anchorId, { kind, q, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
  );
  const authors = await acceptedAuthors(
    member.anchorId,
    res.items.map((i) => i.id),
  );
  const items = res.items.map((i) => ({ ...i, author: authors.get(i.id) ?? null }));
  return NextResponse.json({ ...res, items, page, pageSize: PAGE_SIZE });
}
