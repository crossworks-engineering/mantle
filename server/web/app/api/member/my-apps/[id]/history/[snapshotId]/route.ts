import { NextResponse } from '@/server/http-compat';
import { authorSpaceApp, withAuthorWrite } from '@mantle/content';
import { deleteMemberAppSnapshot } from '@mantle/content/app-snapshots';
import { getMemberOr401 } from '@/lib/auth';
import { memberWriteGate } from '@/lib/member-space';
import {
  auditMemberApp,
  spaceAppErrorResponse,
  spaceAppId,
  spaceAppNotFound,
} from '@/lib/space-apps';

/**
 * DELETE /api/member/my-apps/:id/history/:snapshotId: delete one manual
 * snapshot the member took of their own app, with its copy of the data, to
 * free their snapshot budget (access matrix N6; the my_app_snapshot_delete
 * tool's twin). The app's own data is untouched. A version, an automatic
 * snapshot or another login's is 409 `not-yours`; a submitted app is 409
 * `frozen`.
 */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string; snapshotId: string }> },
) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const limited = memberWriteGate(member);
  if (limited) return limited;
  const params = await ctx.params;
  const id = spaceAppId(params.id);
  const snapshotId = spaceAppId(params.snapshotId);
  if (!id || !snapshotId) return spaceAppNotFound();
  const author = { loginId: member.loginId, spaceId: member.spaceId };
  try {
    await authorSpaceApp(author, id, { write: true });
    const gone = await withAuthorWrite(author, id, () =>
      deleteMemberAppSnapshot(member.spaceId, id, snapshotId, member.loginId),
    );
    if (!gone) {
      return NextResponse.json({ ok: false, error: 'entry not found' }, { status: 404 });
    }
    auditMemberApp(req, member, 'member_app.snapshot_deleted', { appId: id, snapshotId });
    return NextResponse.json({
      ok: true,
      deleted: gone.id,
      seq: gone.seq,
      freedBytes: gone.freedBytes,
    });
  } catch (err) {
    return spaceAppErrorResponse(err);
  }
}
