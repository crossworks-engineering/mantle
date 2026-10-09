/**
 * GET /api/team-admin/member-items/:id[?tab=] : one item an active member
 * shared with the team, with its SAVED version (never the author's draft)
 * and its author. Admin only, read at team level: anything else, a private
 * item included, is a 404. A drawing's picture is ./svg, a file's bytes
 * ./bytes.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getMemberItemShared } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { SubmissionParams, reviewNotFound } from '@/lib/member-review';

const Query = z.object({ tab: z.string().min(1).max(200).optional() });

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = SubmissionParams.safeParse(await ctx.params);
  if (!params.success) return reviewNotFound();
  const query = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return NextResponse.json({ error: 'Invalid tab.' }, { status: 400 });
  const tabId = query.data.tab;
  const got = await getMemberItemShared(params.data.id, tabId ? { tabId } : {});
  if (!got) return reviewNotFound();
  return NextResponse.json(got);
}
