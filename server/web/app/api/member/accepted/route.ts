import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { LIBRARY_KINDS, listAccepted } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';

const Query = z.object({
  kind: z.enum(LIBRARY_KINDS).optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
const PAGE_SIZE = 50;

/**
 * GET /api/member/accepted?kind=&q=&page= : what this MEMBER wrote and an admin
 * accepted into the brain, newest accept first, at whatever level the admin
 * chose (member logins Phase 4, plan 6.2). On the admin pool: the author
 * rule is written in the query (member-accepted.ts), since an item accepted
 * at admin sits above the member's level.
 */
export async function GET(req: Request) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid query.' }, { status: 400 });
  const { kind, q, page } = parsed.data;
  const res = await listAccepted(member.anchorId, member.loginId, {
    kind,
    q,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  return NextResponse.json({ ...res, page, pageSize: PAGE_SIZE });
}
