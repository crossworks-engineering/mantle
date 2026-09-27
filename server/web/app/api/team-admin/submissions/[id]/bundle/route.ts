/**
 * GET /api/team-admin/submissions/:id/bundle : what Accept would move into
 * the brain (the item plus everything that renders inside it, the author's
 * own items only) and how many links point at items that stay behind. For
 * the accept dialog.
 */
import { NextResponse } from '@/server/http-compat';
import { previewAccept } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { SubmissionParams, reviewErrorResponse, reviewNotFound } from '@/lib/member-review';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = SubmissionParams.safeParse(await ctx.params);
  if (!params.success) return reviewNotFound();
  try {
    const bundle = await previewAccept(params.data.id);
    return bundle ? NextResponse.json(bundle) : reviewNotFound();
  } catch (err) {
    return reviewErrorResponse(err);
  }
}
