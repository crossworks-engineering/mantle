import { NextResponse } from '@/server/http-compat';
import { asSystem } from '@mantle/db';
import { authorSpaceApp } from '@mantle/content';
import { listAppSnapshots, memberOwnSnapshotIds } from '@mantle/content/app-snapshots';
import { getMemberOr401 } from '@/lib/auth';
import { spaceAppErrorResponse, spaceAppId, spaceAppNotFound } from '@/lib/space-apps';

/**
 * GET /api/member/my-apps/:id/history: the history of the member's OWN app,
 * newest first (team apps Phase 3): versions (each publish) and snapshots.
 * Restoring one is the my_app_snapshot_restore tool's, on their MCP. Each
 * entry says whether the member may delete it (`deletable`): only a manual
 * snapshot this login took, while the app is not submitted (a trashed app
 * has no history here; access matrix N6).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const id = spaceAppId((await ctx.params).id);
  if (!id) return spaceAppNotFound();
  let editable = false;
  try {
    const app = await authorSpaceApp({ loginId: member.loginId, spaceId: member.spaceId }, id);
    editable = app.reviewState === 'draft' || app.reviewState === 'returned';
  } catch (err) {
    return spaceAppErrorResponse(err);
  }
  const [entries, own] = await asSystem(() =>
    Promise.all([
      listAppSnapshots(member.spaceId, id, { limit: 100 }),
      memberOwnSnapshotIds(member.spaceId, id, member.loginId),
    ]),
  );
  return NextResponse.json({
    entries: entries.map((e) => ({ ...e, deletable: editable && own.has(e.id) })),
  });
}
