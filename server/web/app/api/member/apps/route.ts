import { NextResponse } from '@/server/http-compat';
import { withViewer } from '@mantle/db';
import { appLauncher, loadProfilePreferences, resolveMemberHomeApp } from '@mantle/content';
import type { MemberAppList } from '@mantle/client-types';
import { getMemberOr401 } from '@/lib/auth';

/**
 * GET /api/member/apps: the apps a MEMBER may run (member logins Phase 4b),
 * by title: team level or lower, with a green published build. Plus the
 * brain's home app when a member may run it (else null). Read at the team
 * level. Members only run apps: nothing here creates, edits or shares one.
 *
 * `folders`: where those apps sit in the admin's Apps folders, read only. A
 * folder is answered only when it leads to an app of this list, so a folder
 * with nothing the member may run is never named. `appLauncher` reads the
 * apps on the team role and the folder rows (the brain's) on the admin pool,
 * along those apps' paths and nowhere else; when that folder read fails the
 * apps still list, with no folders.
 */
export async function GET() {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const prefs = await loadProfilePreferences(member.anchorId);
  const [{ apps, folders }, home] = await Promise.all([
    appLauncher(member.anchorId, 'team'),
    withViewer('team', () => resolveMemberHomeApp(member.anchorId, prefs.teamHubAppId)),
  ]);
  return NextResponse.json({
    apps,
    homeAppId: home?.appId ?? null,
    folders,
  } satisfies MemberAppList);
}
