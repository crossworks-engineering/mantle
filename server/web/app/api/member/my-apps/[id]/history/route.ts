import { NextResponse } from '@/server/http-compat';
import { asSystem } from '@mantle/db';
import { authorSpaceApp } from '@mantle/content';
import { listAppSnapshots } from '@mantle/content/app-snapshots';
import { getMemberOr401 } from '@/lib/auth';
import { spaceAppErrorResponse, spaceAppId, spaceAppNotFound } from '@/lib/space-apps';

/**
 * GET /api/member/my-apps/:id/history: the history of the member's OWN app,
 * newest first (team apps Phase 3): versions (each publish) and snapshots.
 * Restoring one is the my_app_snapshot_restore tool's, on their MCP.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const id = spaceAppId((await ctx.params).id);
  if (!id) return spaceAppNotFound();
  try {
    await authorSpaceApp({ loginId: member.loginId, spaceId: member.spaceId }, id);
  } catch (err) {
    return spaceAppErrorResponse(err);
  }
  const entries = await asSystem(() => listAppSnapshots(member.spaceId, id, { limit: 100 }));
  return NextResponse.json({ entries });
}
