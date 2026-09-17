/**
 * GET /api/team/workspace — everything the /team workspace SHELL renders:
 * the caller's display name, the brain's site name + colour theme, per-type
 * counts of team-visible shares (nav badges + overview tiles), and the shared
 * folders (the footer's folder chips). Section CONTENT comes from
 * /api/team/list; this route stays a cheap shell bootstrap.
 *
 * Same trust model as the rest of /api/team: self-authenticated via
 * resolveTeamChatCaller (cookie or bearer), membership liveness re-checked on
 * every call. Read-only.
 */
import { NextResponse } from '@/server/http-compat';
import {
  countTeamVisibleShares,
  listTeamVisibleShares,
  loadProfilePreferences,
  logoVersion,
} from '@mantle/content';
import { resolveTeamChatCaller, teamCallerName } from '@/lib/team-chat-gate';
import { APP_VERSION } from '@mantle/client-types/version';

export async function GET(req: Request) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const [memberName, prefs, counts, folders] = await Promise.all([
    teamCallerName(caller.ownerId, caller.contactId),
    loadProfilePreferences(caller.ownerId),
    countTeamVisibleShares(caller.ownerId),
    listTeamVisibleShares(caller.ownerId, 'branch'),
  ]);

  return NextResponse.json({
    memberName: memberName ?? null,
    siteName: prefs.siteName ?? null,
    // The brain's federation label — the member header centres it exactly as
    // the owner shell does (one brand, admin-determined, both surfaces).
    peerName: prefs.peerName ?? null,
    // Brand logo (replaces the wordmark when set) — same public src +
    // version contract as the owner shell.
    logoVersion: logoVersion(prefs.logoKey),
    logoDarkVersion: logoVersion(prefs.logoDarkKey),
    // The OWNER's colour theme — the workspace renders in the brain's brand
    // theme for members (light/dark stays the member's own choice).
    colorTheme: prefs.colorTheme ?? null,
    version: APP_VERSION,
    counts,
    folders: folders.map((f) => ({ token: f.token, title: f.title })),
  });
}
