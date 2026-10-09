/**
 * GET /api/apps/members/:id/activity: what a member's app did (access
 * matrix N3): its runs, tool calls and writes, connector inputs included,
 * newest first. Logged under the author's space while it is a member's app;
 * Approve moves them to the brain app's own Activity view.
 */
import { NextResponse } from '@/server/http-compat';
import { asSystem } from '@mantle/db';
import { listAppAccess } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { reviewAppOr404 } from '@/lib/review-apps';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const app = await reviewAppOr404((await ctx.params).id);
  if (app instanceof Response) return app;
  const entries = await asSystem(() => listAppAccess(app.spaceId, app.id, 200));
  return NextResponse.json({ entries });
}
