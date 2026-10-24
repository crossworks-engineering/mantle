/**
 * Owner-only backing API for the brain's member settings (once the Team
 * admin surface's). GET returns the read posture. PATCH flips the
 * `teamPrivateReads` switch. It has no effect on any workspace turn today:
 * an assistant of a workspace other than Admin never runs as the Admin
 * assistant (run-team-turn.ts), mail and journal entries live in the Admin
 * workspace only (mantle_grant_kind_ok, 0241) and their read tools are
 * Admin only (team-read-admin). The guide says so (team-admin.md), and the
 * client's words with it. `teamAssistant` is null since 0286: Team is
 * a normal workspace, and each workspace's screen names its own assistant
 * (a member with no assistant named chats with defaultWorkspaceAssistant's
 * pick). The member home app designation left with per-workspace landing
 * pages (task d78e7bde): each workspace sets its home app on its own screen.
 * Session/bearer-gated: `/api/team-admin` is not in PUBLIC_PATHS.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import {
  updateProfilePreferences,
  loadProfilePreferences,
  isTeamPrivateReadsEnabled,
} from '@mantle/content';
import { teamAdminBadges } from '@/lib/team-admin-overview';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'users' },
  PATCH: {
    class: 'area',
    area: 'users',
    item: { none: 'manages the users area: the Admin step checks it' },
  },
});

export async function GET() {
  const user = ownerCaller();
  const [badges, prefs] = await Promise.all([
    teamAdminBadges(user.id),
    loadProfilePreferences(user.id),
  ]);
  return NextResponse.json({
    badges,
    privateReads: isTeamPrivateReadsEnabled(prefs),
    // An older client's Team settings still render a member home app picker
    // from these two (audit M3): empty, so it shows the Built-in home and
    // offers nothing. Remove both after the next client pair.
    hubAppId: null,
    hubCandidates: [],
    // No workspace is the members' since 0286 (an older client's Member
    // chat line shows "none"; it showed only on the built-in Team).
    teamAssistant: null,
  });
}

export async function PATCH(req: Request) {
  const user = ownerCaller();
  const body = await readJson(req, { refuseEmpty: true });
  const teamPrivateReads = (body as { teamPrivateReads?: unknown }).teamPrivateReads;
  if (typeof teamPrivateReads !== 'boolean') {
    return NextResponse.json({ error: 'teamPrivateReads must be a boolean' }, { status: 400 });
  }
  await updateProfilePreferences(user.id, { teamPrivateReads });
  return NextResponse.json({ teamPrivateReads });
}
