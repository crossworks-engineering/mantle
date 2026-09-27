import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getAcceptedItem } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';

const Params = z.object({ id: z.string().uuid() });
/** A table's tab id (from the item's `tabs` list); absent = the first tab. */
const Query = z.object({ tab: z.string().min(1).max(200).optional() });

/**
 * GET /api/member/accepted/:id[?tab=] : an item this MEMBER wrote and an
 * admin accepted, the SAVED version (never an admin's draft), whatever its
 * level (plan 6.2: the author keeps read access to what they wrote). Anyone
 * else's item, one that was not accepted, or one that left this brain is a
 * plain 404, the same answer as an id that does not exist.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const query = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return NextResponse.json({ error: 'Invalid tab.' }, { status: 400 });
  const tabId = query.data.tab;
  const item = await getAcceptedItem(
    member.anchorId,
    member.loginId,
    params.data.id,
    tabId ? { tabId } : {},
  );
  if (!item) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ item });
}
