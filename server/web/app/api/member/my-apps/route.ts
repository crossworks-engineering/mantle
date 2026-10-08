import { NextResponse } from '@/server/http-compat';
import { listSpaceApps } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';

/**
 * GET /api/member/my-apps: the apps members BUILT (team apps Phase 3): the
 * member's own, in any state before Accept (private, shared, submitted,
 * returned), and the published apps teammates shared with the team. A
 * teammate's private app is never listed. Members build over their own MCP
 * connection (the my_app_* tools); this list is where they share, submit
 * and run them.
 */
export async function GET() {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const apps = await listSpaceApps({ loginId: member.loginId, spaceId: member.spaceId });
  return NextResponse.json({ apps });
}
