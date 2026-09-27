import { NextResponse } from '@/server/http-compat';
import { withViewer } from '@mantle/db';
import {
  libraryCounts,
  listLibrary,
  listMemberApps,
  loadProfilePreferences,
  resolveMemberHomeApp,
} from '@mantle/content';
import { APP_VERSION } from '@mantle/client-types/version';
import { getMemberOr401 } from '@/lib/auth';
import { memberName } from '@/lib/member-apps';

/** How many team pages the home app gets as briefing sections. */
const SECTION_LIMIT = 30;

/**
 * GET /api/member/home: the member home (member logins Phase 4b, plan 4a
 * "Hub app"). `homeApp` is the brain's pinned home app when the member may run
 * it (team level or lower, published); null means the built-in member home
 * (and `hub` is null too).
 * The rest is what the app's `host.hub.get()` answers, in the team hub's
 * shape (docs/team-hub-app-sdk.md): the site name, the member's name, the
 * newest team pages as sections (`token` is the page id: the member shell
 * opens it in the Library), Library counts, and the other apps the member may
 * run as launcher cards (`token` is the app id). Read at the team level.
 */
export async function GET() {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const prefs = await loadProfilePreferences(member.anchorId);
  const homeApp = await withViewer('team', () =>
    resolveMemberHomeApp(member.anchorId, prefs.teamHubAppId),
  );
  // Most brains pin nothing: the built-in home needs no hub data.
  if (!homeApp) return NextResponse.json({ homeApp: null, hub: null });
  const [pages, counts, apps] = await withViewer('team', () =>
    Promise.all([
      listLibrary(member.anchorId, { kind: 'page', limit: SECTION_LIMIT }),
      libraryCounts(member.anchorId),
      listMemberApps(member.anchorId),
    ]),
  );
  return NextResponse.json({
    homeApp,
    hub: {
      siteName: prefs.siteName ?? null,
      memberName: memberName(member),
      version: APP_VERSION,
      sections: pages.items.map((p) => ({
        token: p.id,
        title: p.title,
        icon: p.icon,
        summary: p.summary,
        updatedAt: p.updatedAt,
        parentToken: null,
      })),
      counts,
      apps: apps
        .filter((a) => a.id !== homeApp.appId)
        .map((a) => ({
          token: a.id,
          title: a.title,
          description: a.description,
          updatedAt: a.updatedAt,
        })),
    },
  });
}
