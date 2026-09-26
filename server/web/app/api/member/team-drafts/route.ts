import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withTeamDrafts } from '@mantle/db';
import { SPACE_ITEM_KINDS, listTeamDrafts } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';

const Query = z.object({
  kind: z.enum(SPACE_ITEM_KINDS).optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
const PAGE_SIZE = 50;

/**
 * GET /api/member/team-drafts?kind=&q=&page= : other members' items shared
 * with the team ("Team drafts"), newest first. Read on the team role with the
 * human flag on: the only scope that sees them (an agent never does).
 */
export async function GET(req: Request) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid query.' }, { status: 400 });
  const { kind, q, page } = parsed.data;
  const res = await withTeamDrafts(() =>
    listTeamDrafts(member.loginId, { kind, q, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
  );
  return NextResponse.json({ ...res, page, pageSize: PAGE_SIZE });
}
