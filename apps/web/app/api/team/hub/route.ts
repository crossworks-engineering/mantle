/**
 * GET /api/team/hub — everything the /team landing (Team Hub) renders:
 * the caller's display name, the brain's site name, the briefing sections
 * (the owner's team-mode page shares — see @mantle/content/team-hub), and
 * coarse per-type content counts for the stat tiles.
 *
 * Same trust model as the rest of /api/team: self-authenticated via
 * resolveTeamChatCaller (cookie or bearer), membership liveness re-checked on
 * every call. Read-only; counts only, never content.
 */
import { NextResponse } from 'next/server';
import {
  listTeamHubSections,
  loadProfilePreferences,
  teamHubContentCounts,
} from '@mantle/content';
import { resolveTeamChatCaller, teamCallerName } from '@/lib/team-chat-gate';
import { APP_VERSION } from '@/lib/version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const [memberName, prefs, sections, counts] = await Promise.all([
    teamCallerName(caller.ownerId, caller.contactId),
    loadProfilePreferences(caller.ownerId),
    listTeamHubSections(caller.ownerId),
    teamHubContentCounts(caller.ownerId),
  ]);

  return NextResponse.json({
    memberName: memberName ?? null,
    siteName: prefs.siteName ?? null,
    version: APP_VERSION,
    sections,
    counts,
  });
}
