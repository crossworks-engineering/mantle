/**
 * Owner-only designation of the HOME APP: the mini-app a member login's home
 * renders full-bleed in place of the built-in member home
 * (`resolveMemberHomeApp`, GET /api/member/home). The pref is still named
 * `teamHubAppId`: the retired team-code /hub (member logins Phase 6) was its
 * first reader.
 *
 * PUT { appId } — designate: requires a green PUBLISHED build, puts an app
 * still at admin at team (members run apps by level, not by link), then
 * points the `teamHubAppId` pref at it. An app at team, client or public
 * keeps its level. No share link is made (team links are retired, member
 * logins Phase 6 stage 6). Answers `{ appId, levelChanged, modeChanged }`;
 * `modeChanged` repeats `levelChanged` for one contract cycle (it meant "the
 * link went team-only").
 *
 * DELETE — undesignate: clears the pref only. The app keeps its level.
 *
 * Session-gated — under /api/team-admin, which is NOT in PUBLIC_PATHS, so it
 * carries the owner session, never a team token.
 */
import { NextResponse } from '@/server/http-compat';
import {
  getApp,
  projectTeamHubAppId,
  setItemLevel,
  updateProfilePreferences,
} from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  // Normalise + validate up front: a non-UUID would otherwise reach the
  // node lookup and throw a Postgres cast error (a 500 for a caller typo).
  // `body` can be JSON `null` — hence the optional access.
  const appId = projectTeamHubAppId((body as { appId?: unknown } | null)?.appId);
  if (!appId) {
    return NextResponse.json({ error: 'appId must be an app UUID' }, { status: 400 });
  }

  const app = await getApp(user.id, appId);
  if (!app) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  if (app.publishedBuild?.ok !== true) {
    return NextResponse.json(
      { error: 'the app has no published build — publish it before designating it as the hub' },
      { status: 409 },
    );
  }

  // A member runs an app at team, client or public (resolveMemberHomeApp);
  // one still at admin goes to team, or the designation would show nobody.
  const levelChanged = app.audience === 'admin';
  if (levelChanged) await setItemLevel(user.id, appId, 'team');

  await updateProfilePreferences(user.id, { teamHubAppId: appId });
  return NextResponse.json({ appId, levelChanged, modeChanged: levelChanged });
}

export async function DELETE() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  // '' is the deliberate clear — projects to undefined on read.
  await updateProfilePreferences(user.id, { teamHubAppId: '' });
  return NextResponse.json({ cleared: true });
}
