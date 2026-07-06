/**
 * Caller resolution for the Team Chat surface (/team + /api/team/*).
 *
 * Two credentials resolve to the same identity:
 *   - the signed `mantle_team_chat` cookie (browser members, minted by
 *     POST /api/team/auth), or
 *   - `Authorization: Bearer <contact team token>` (API clients — the MS Teams
 *     adapter seam). The bearer path re-verifies the raw token by hash on every
 *     call, so revocation is instant there too.
 *
 * Either way, membership LIVENESS is re-checked against contact_team_tokens on
 * every request — the cookie/token alone is never sufficient, so removing a
 * member locks them out mid-session.
 */
import { getContact, isTeamMember, verifyTeamToken } from '@mantle/content';
import { TEAM_CHAT_COOKIE, verifyTeamChatValue } from '@/lib/auth';
import type { TeamChannel } from '@mantle/db';

export type TeamChatCaller = {
  ownerId: string;
  contactId: string;
  /** How they authenticated — tags the turn's channel + the access log. */
  channel: Extract<TeamChannel, 'web' | 'api'>;
};

/** Every value of the team-chat cookie in a raw Cookie header. */
function teamChatCookieValues(cookieHeader: string | null): string[] {
  if (!cookieHeader) return [];
  const out: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== TEAM_CHAT_COOKIE) continue;
    const v = part.slice(eq + 1).trim();
    if (v) out.push(decodeURIComponent(v));
  }
  return out;
}

/**
 * Resolve who's calling the team surface, or null (caller responds 401 / shows
 * the token prompt). Bearer wins over cookie so an API client with a stale
 * cookie in its jar still authenticates as its token says.
 */
export async function resolveTeamChatCaller(req: Request): Promise<TeamChatCaller | null> {
  const authz = req.headers.get('authorization');
  if (authz?.toLowerCase().startsWith('bearer ')) {
    const member = await verifyTeamToken(authz.slice(7).trim());
    if (member && (await isTeamMember(member.ownerId, member.contactId))) {
      return { ownerId: member.ownerId, contactId: member.contactId, channel: 'api' };
    }
    return null; // an explicit-but-bad bearer never falls through to the cookie
  }
  for (const value of teamChatCookieValues(req.headers.get('cookie'))) {
    const claims = verifyTeamChatValue(value);
    if (!claims) continue;
    // Liveness: the cookie is necessary but never sufficient.
    if (await isTeamMember(claims.ownerId, claims.contactId)) {
      return { ownerId: claims.ownerId, contactId: claims.contactId, channel: 'web' };
    }
  }
  return null;
}

/** The member's display name for the identity context line + provenance.
 *  Best-effort — a missing contact resolves to undefined, never throws. */
export async function teamCallerName(
  ownerId: string,
  contactId: string,
): Promise<string | undefined> {
  try {
    const contact = await getContact(ownerId, contactId);
    return contact?.title || undefined;
  } catch {
    return undefined;
  }
}

/** Team turn ids are client-minted like owner turn ids, but MUST carry this
 *  prefix. The team stream route only serves prefixed ids, and owner surfaces
 *  never mint them — so a member can never tail an owner turn's live stream by
 *  guessing/obtaining its id. */
export const TEAM_TURN_ID_PREFIX = 'team-';

export function isTeamTurnId(id: string): boolean {
  return id.startsWith(TEAM_TURN_ID_PREFIX) && id.length > TEAM_TURN_ID_PREFIX.length;
}
