import { NextResponse } from '@/server/http-compat';
import { withViewer } from '@mantle/db';
import { listMemberApps, loadProfilePreferences, resolveMemberHomeApp } from '@mantle/content';
import type { MemberAppList } from '@mantle/client-types';
import { getMemberOr401 } from '@/lib/auth';

/**
 * GET /api/member/apps: the apps a MEMBER may run (member logins Phase 4b),
 * by title: team level or lower, with a green published build. Plus the
 * brain's home app when a member may run it (else null). Read at the team
 * level. Members only run apps: nothing here creates, edits or shares one.
 */
export async function GET() {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const prefs = await loadProfilePreferences(member.anchorId);
  const [apps, home] = await withViewer('team', () =>
    Promise.all([
      listMemberApps(member.anchorId),
      resolveMemberHomeApp(member.anchorId, prefs.teamHubAppId),
    ]),
  );
  return NextResponse.json({ apps, homeAppId: home?.appId ?? null } satisfies MemberAppList);
}
