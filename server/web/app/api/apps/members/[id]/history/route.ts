/**
 * GET /api/apps/members/:id/history: a member's app's history, newest first:
 * versions (each publish) and snapshots. Read only: restoring is the
 * author's (my_app_snapshot_restore). 404 for an app an admin may not reach.
 */
import { NextResponse } from '@/server/http-compat';
import { asSystem } from '@mantle/db';
import { listAppSnapshots } from '@mantle/content/app-snapshots';
import { getOwnerOr401 } from '@/lib/auth';
import { reviewAppOr404 } from '@/lib/review-apps';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const app = await reviewAppOr404((await ctx.params).id);
  if (app instanceof Response) return app;
  const entries = await asSystem(() => listAppSnapshots(app.spaceId, app.id, { limit: 100 }));
  return NextResponse.json({ entries });
}
