import { NextResponse } from '@/server/http-compat';
import { withViewer } from '@mantle/db';
import { appLauncher, loadProfilePreferences, resolveMemberHomeApp } from '@mantle/content';
import type { MemberAppList } from '@mantle/client-types';
import { getMemberOr401 } from '@/lib/auth';
import { ruleInQuery } from '@/lib/auth/rule-in-query';

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
 *
 * The request runs in the member's scope (W7e); this handler leaves it by
 * name (ruleInQuery, as the shell does): the apps are read in that scope
 * (withViewer), the brain's home pin and the folder rows by their own rule.
 */
async function handleGET() {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const prefs = await loadProfilePreferences(member.anchorId);
  const [{ apps, folders }, home] = await Promise.all([
    appLauncher(member.anchorId, 'team', member.loginId),
    withViewer({ login: member.loginId }, () =>
      resolveMemberHomeApp(member.anchorId, prefs.teamHubAppId),
    ),
  ]);
  return NextResponse.json({
    apps,
    homeAppId: home?.appId ?? null,
    folders,
  } satisfies MemberAppList);
}

export const GET = ruleInQuery(handleGET);
