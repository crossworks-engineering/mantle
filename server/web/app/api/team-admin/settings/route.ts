/**
 * Owner-only backing API for the Team admin surface's settings. GET returns
 * the Settings tab's data (read posture, hub-app designation + candidates,
 * curated dashboard tags — what the old SSR page computed); PATCH flips the
 * `teamPrivateReads` switch (whether the Team Chat responder may read the
 * owner's email + journal on a member's behalf). Session/bearer-gated — under
 * `/api/team-admin`, which is NOT in PUBLIC_PATHS (only `/api/team` is), so it
 * carries the owner credential, never a team token.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import {
  updateProfilePreferences,
  loadProfilePreferences,
  isTeamPrivateReadsEnabled,
  listApps,
  listTeamShareTags,
} from '@mantle/content';
import { teamAdminBadges } from '@/lib/team-admin-overview';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [badges, prefs, apps, sharedPageTags] = await Promise.all([
    teamAdminBadges(user.id),
    loadProfilePreferences(user.id),
    listApps(user.id, { limit: 200 }),
    listTeamShareTags(user.id, 'page'),
  ]);
  // Designation candidates: published apps only (the PATCH API enforces it
  // too). Include the current designee even if its build went red, LABELLED —
  // the owner must see that members currently get the built-in fallback.
  const hubCandidates = apps
    .filter((a) => a.hasBuild || a.id === prefs.teamHubAppId)
    .map((a) => ({
      id: a.id,
      title: a.hasBuild ? a.title : `${a.title} (build failed — members see the built-in hub)`,
    }));
  const hubAppId =
    prefs.teamHubAppId && apps.some((a) => a.id === prefs.teamHubAppId) ? prefs.teamHubAppId : null;
  return NextResponse.json({
    badges,
    privateReads: isTeamPrivateReadsEnabled(prefs),
    hubAppId,
    hubCandidates,
    dashboardTags: { selected: prefs.teamHubTags ?? [], available: sharedPageTags },
  });
}

export async function PATCH(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const teamPrivateReads = (body as { teamPrivateReads?: unknown }).teamPrivateReads;
  if (typeof teamPrivateReads !== 'boolean') {
    return NextResponse.json({ error: 'teamPrivateReads must be a boolean' }, { status: 400 });
  }
  await updateProfilePreferences(user.id, { teamPrivateReads });
  return NextResponse.json({ teamPrivateReads });
}
