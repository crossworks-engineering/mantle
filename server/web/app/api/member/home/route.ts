import { NextResponse } from '@/server/http-compat';
import type { MemberHomeData } from '@mantle/client-types';
import type { HubData } from '@mantle/share-ui/app-bridge-protocol';
import { getMemberOr401 } from '@/lib/auth';
import { landingName, teamWorkspaceOf, workspaceHome } from '@/lib/landing';

/**
 * GET /api/member/home: the member home of an app older than per-workspace
 * landing pages (task d78e7bde). Every login now reads GET /api/home?ws=,
 * the landing page of its current workspace. The one brain-wide member
 * home app this route answered became the Team workspace's home app
 * (migration 0275), so this answers the Team workspace's landing page in
 * the old shape: `homeApp` is the Team's home app when the member may run
 * it, and then `hub` is its data, kept to what Team reads; null for both
 * means the built-in member home. A member not in Team gets nulls.
 *
 * It reads team items, so it runs in the member's request scope
 * (route-scope classes it 'content', W7e fix round 1, L1).
 */
export async function GET() {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const who = {
    anchorId: member.anchorId,
    loginId: member.loginId,
    name: landingName(member),
  };
  const team = await teamWorkspaceOf(who);
  const home = team ? await workspaceHome(who, team) : null;
  if (!home?.homeApp) {
    return NextResponse.json({ homeApp: null, hub: null } satisfies MemberHomeData);
  }
  return NextResponse.json({
    homeApp: home.homeApp,
    hub: home.hub,
  } satisfies MemberHomeData<HubData>);
}
