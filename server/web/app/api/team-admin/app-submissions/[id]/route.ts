/**
 * GET /api/team-admin/app-submissions/:id: one submitted member app with its
 * PUBLISHED source, what will run once accepted (team apps Phase 3). 404
 * when it is not waiting for review.
 */
import { NextResponse } from '@/server/http-compat';
import { getSpaceAppSubmission } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { spaceAppId, spaceAppNotFound } from '@/lib/space-apps';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const id = spaceAppId((await ctx.params).id);
  if (!id) return spaceAppNotFound();
  const submission = await getSpaceAppSubmission(id);
  if (!submission) return spaceAppNotFound();
  return NextResponse.json({ submission });
}
