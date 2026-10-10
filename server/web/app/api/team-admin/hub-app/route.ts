/**
 * Owner-only designation of the HOME APP: the mini-app a member login's home
 * renders full-bleed in place of the built-in member home
 * (`resolveMemberHomeApp`, GET /api/member/home). The pref is still named
 * `teamHubAppId`: the retired team-code /hub (member logins Phase 6) was its
 * first reader.
 *
 * PUT { appId } designates it. It requires a green PUBLISHED build and an app the
 * Team workspace reads (members run what Team reads), then points the
 * `teamHubAppId` pref at it. No grant is made here (workspaces W5b2, no
 * magic): an app Team does not read is refused with 409 `not_in_team`, and
 * the admin shares it with Team in Grant Access first. No share link is made
 * either. Answers `{ appId, levelChanged: false }` (`levelChanged` stays on
 * the wire for older clients; nothing changes level any more).
 *
 * DELETE undesignates it: it clears the pref only. The app keeps its grants.
 *
 * Session-gated — under /api/team-admin, which is NOT in PUBLIC_PATHS, so it
 * carries the owner session, never a team token.
 */
import { NextResponse } from '@/server/http-compat';
import {
  getApp,
  projectTeamHubAppId,
  teamReadsItem,
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

  // Members run what Team reads: an app Team does not read would show
  // nobody, and the grant is the admin's to make (no magic grant).
  if (!(await teamReadsItem(user.id, appId))) {
    return NextResponse.json(
      { error: 'Share the app with Team in Grant Access first.', code: 'not_in_team' },
      { status: 409 },
    );
  }

  await updateProfilePreferences(user.id, { teamHubAppId: appId });
  return NextResponse.json({ appId, levelChanged: false });
}

export async function DELETE() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  // '' is the deliberate clear — projects to undefined on read.
  await updateProfilePreferences(user.id, { teamHubAppId: '' });
  return NextResponse.json({ cleared: true });
}
