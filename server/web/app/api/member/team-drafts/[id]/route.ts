import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withTeamDrafts } from '@mantle/db';
import { getTeamDraftItem } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';

const Params = z.object({ id: z.string().uuid() });
/** A table's tab id; absent or unknown = the first tab. */
const Query = z.object({ tab: z.string().min(1).max(200).optional() });

/**
 * GET /api/member/team-drafts/:id[?tab=] : one team-shared item with its
 * SAVED version (never the author's draft). A drawing's picture comes from
 * /api/member/draws/:id/svg, a file's bytes from ./bytes. Private items are a
 * plain 404.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const query = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return NextResponse.json({ error: 'Invalid tab.' }, { status: 400 });
  const tabId = query.data.tab;
  const got = await withTeamDrafts(() => getTeamDraftItem(params.data.id, tabId ? { tabId } : {}));
  if (!got) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json(got);
}
