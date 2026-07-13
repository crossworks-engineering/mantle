/**
 * GET /api/team/hub — everything the /team landing (Team Hub) renders:
 * the caller's display name, the brain's site name, the briefing sections
 * (the owner's team-mode page shares — see @mantle/content/team-hub), the
 * launcher cards (the owner's other team-mode app shares), and coarse
 * per-type content counts for the stat tiles.
 *
 * Same trust model as the rest of /api/team: self-authenticated via
 * resolveTeamChatCaller (cookie or bearer), membership liveness re-checked on
 * every call. Read-only; counts only, never content.
 */
import { NextResponse } from 'next/server';
import {
  listTeamApps,
  listTeamHubSections,
  loadProfilePreferences,
  resolveTeamHubApp,
  teamHubContentCounts,
} from '@mantle/content';
import { resolveTeamChatCaller, teamCallerName } from '@/lib/team-chat-gate';
import { APP_VERSION } from '@/lib/version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Designated team-hub app resolution depends only on prefs, so it chains off
  // the prefs promise and overlaps the sections/counts queries instead of
  // adding a serial round-trip to the hub's hot path. Honoured only when the
  // whole chain is intact (pref → app → green published build → active
  // team-mode share) — the shell falls back to the built-in hub when null.
  const prefsPromise = loadProfilePreferences(caller.ownerId);
  const [memberName, prefs, sections, counts, hubApp, teamApps] = await Promise.all([
    teamCallerName(caller.ownerId, caller.contactId),
    prefsPromise,
    listTeamHubSections(caller.ownerId),
    teamHubContentCounts(caller.ownerId),
    prefsPromise.then((p) => resolveTeamHubApp(caller.ownerId, p.teamHubAppId)),
    // Launcher cards: the owner's other team-shared apps. Excluded by the PREF
    // (not the resolved hub) so a designated app never lists itself — and a
    // red-build designee can't sneak onto the launcher via the fallback path
    // either, because listTeamApps requires a green published build anyway.
    prefsPromise.then((p) => listTeamApps(caller.ownerId, p.teamHubAppId)),
  ]);

  return NextResponse.json({
    memberName: memberName ?? null,
    siteName: prefs.siteName ?? null,
    version: APP_VERSION,
    sections,
    counts,
    apps: teamApps,
    hubApp: hubApp ? { appId: hubApp.appNodeId, shareToken: hubApp.shareToken } : null,
  });
}
