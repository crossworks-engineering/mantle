import { NextResponse } from '@/server/http-compat';
import { listSpaceApps, undeleteSpaceApp } from '@mantle/content';
import { MY_APPS_MAX } from '@mantle/tools';
import { getMemberOr401 } from '@/lib/auth';
import { memberWriteGate } from '@/lib/member-space';
import {
  auditMemberApp,
  spaceAppErrorResponse,
  spaceAppId,
  spaceAppNotFound,
} from '@/lib/space-apps';

/**
 * POST /api/member/my-apps/:id/undelete: bring the member's own app back
 * from their trash, private and a draft, with its code, data and history
 * (access matrix N6; the my_app_undelete tool's twin). At MY_APPS_MAX live
 * apps it is 409 `limit`.
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
    const mine = (await listSpaceApps(author)).filter((a) => a.mine).length;
    if (mine >= MY_APPS_MAX) {
      return NextResponse.json(
        {
          ok: false,
          error: `You have ${mine} apps, the most one member keeps. Delete one you no longer need, then bring this one back.`,
          reason: 'limit',
        },
        { status: 409 },
      );
    }
    const app = await undeleteSpaceApp(author, id);
    auditMemberApp(req, member, 'member_app.undeleted', { appId: id });
    return NextResponse.json({ ok: true, app });
  } catch (err) {
    return spaceAppErrorResponse(err);
  }
}
