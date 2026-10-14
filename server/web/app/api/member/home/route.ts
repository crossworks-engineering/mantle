import { NextResponse } from '@/server/http-compat';
import type { MemberHomeData } from '@mantle/client-types';
import type { HubData } from '@mantle/share-ui/app-bridge-protocol';
import { memberCaller } from '@/lib/auth';
import { firstSharedWorkspaceOf, landingName, workspaceHome } from '@/lib/landing';

/**
 * GET /api/member/home: the member home of an app older than per-workspace
 * landing pages (task d78e7bde). Every login now reads GET /api/home?ws=,
 * the landing page of its current workspace. The one brain-wide member
 * home app this route answered became the Team workspace's home app
 * (migration 0276), so this answers the landing page of the member's first
 * shared workspace (the oldest one beyond Admin and its private one: Team
 * on a brain switched before 0286, firstSharedWorkspaceOf) in the old
 * shape: `homeApp` is its home app when the member may run it, and then
 * `hub` is its data, kept to what it reads; null for both means the
 * built-in member home. A member in no shared workspace gets nulls.
 *
 * It reads team items, so it runs in the member's request scope
 * (route-scope classes it 'content', W7e fix round 1, L1).
 */
export async function GET() {
  const member = memberCaller();
  const who = {
    anchorId: member.anchorId,
    loginId: member.loginId,
    name: landingName(member),
  };
  const ws = await firstSharedWorkspaceOf(who);
  const home = ws ? await workspaceHome(who, ws) : null;
  if (!home?.homeApp) {
    return NextResponse.json({ homeApp: null, hub: null } satisfies MemberHomeData);
  }
  return NextResponse.json({
    homeApp: home.homeApp,
    hub: home.hub,
  } satisfies MemberHomeData<HubData>);
}
