/**
 * GET /api/apps/members/:id: one member's app for the admin's app screen:
 * its PUBLISHED source (never the author's draft), the tools it declares,
 * the author and where it stands. While it waits for approval it carries
 * `version` and `reviewHash`, what an Approve sends back (the brain refuses
 * any other version). 404 for an app an admin may not reach.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { reviewAppDto, reviewAppOr404 } from '@/lib/review-apps';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const app = await reviewAppOr404((await ctx.params).id);
  if (app instanceof Response) return app;
  return NextResponse.json({ app: reviewAppDto(app) });
}
