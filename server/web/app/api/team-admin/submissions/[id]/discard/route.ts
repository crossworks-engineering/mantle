/**
 * POST /api/team-admin/submissions/:id/discard : delete an item a
 * deactivated (or deleted) login left behind, shared with the team or
 * submitted (plan 6.4). An active author's item is refused (409): return it
 * instead.
 */
import { NextResponse } from '@/server/http-compat';
import { discardLeftBehind } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { SubmissionParams, reviewErrorResponse, reviewNotFound } from '@/lib/member-review';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = SubmissionParams.safeParse(await ctx.params);
  if (!params.success) return reviewNotFound();
  try {
    await discardLeftBehind(params.data.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return reviewErrorResponse(err);
  }
}
