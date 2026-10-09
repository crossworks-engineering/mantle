import { NextResponse } from '@/server/http-compat';
import { deleteSpaceApp, listDeletedSpaceApps } from '@mantle/content';
import { MY_APPS_TRASH_MAX } from '@mantle/tools';
import { getMemberOr401 } from '@/lib/auth';
import { memberWriteGate } from '@/lib/member-space';
import {
  auditMemberApp,
  spaceAppErrorResponse,
  spaceAppId,
  spaceAppNotFound,
} from '@/lib/space-apps';

/**
 * POST /api/member/my-apps/:id/delete: move the member's own app to their
 * trash (access matrix N6; the my_app_delete tool's twin). It stops running
 * for everyone, leaves the review queue if submitted and becomes private;
 * its code, data and history are all kept. An accepted app is the brain's,
 * not found here. A full trash (MY_APPS_TRASH_MAX) is 409 `trash-full`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const limited = memberWriteGate(member);
  if (limited) return limited;
  const id = spaceAppId((await ctx.params).id);
  if (!id) return spaceAppNotFound();
  const author = { loginId: member.loginId, spaceId: member.spaceId };
  try {
    const inTrash = (await listDeletedSpaceApps(author)).length;
    if (inTrash >= MY_APPS_TRASH_MAX) {
      return NextResponse.json(
        {
          ok: false,
          error: `Your trash already holds ${inTrash} apps, the most it keeps, and nothing in it is ever deleted. Bring one back and submit it, so an admin can approve it into the brain or delete it, then try again.`,
          reason: 'trash-full',
        },
        { status: 409 },
      );
    }
    const done = await deleteSpaceApp(author, id);
    auditMemberApp(req, member, 'member_app.deleted', { appId: id });
    return NextResponse.json({ ok: true, app: done });
  } catch (err) {
    return spaceAppErrorResponse(err);
  }
}
