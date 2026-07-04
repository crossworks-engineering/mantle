/**
 * Visitor resolution for the /s/<token> app-share surface.
 *
 * Public-mode shares admit anyone (the original model). Team-mode shares
 * require a team-visitor cookie minted by POST /s/<token>/auth — and even
 * then, membership LIVENESS is re-checked against contact_team_tokens on
 * every call, so removing someone from the team locks them out mid-session,
 * cookie or not.
 */
import { shareModeOf, isTeamMember } from '@mantle/content';
import type { Share } from '@mantle/db';
import { TEAM_VISITOR_COOKIE, verifyTeamVisitorValue } from '@/lib/auth';

export type ShareVisitor =
  | { mode: 'public'; contactId: null }
  | { mode: 'team'; contactId: string };

/** Every value of the team-visitor cookie in a raw Cookie header. Path scoping
 *  means at most one normally arrives, but parse liberally. */
function teamCookieValues(cookieHeader: string | null): string[] {
  if (!cookieHeader) return [];
  const out: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== TEAM_VISITOR_COOKIE) continue;
    const v = part.slice(eq + 1).trim();
    if (v) out.push(decodeURIComponent(v));
  }
  return out;
}

/**
 * Resolve who's visiting this share. Returns null when a team-mode share has
 * no valid, LIVE team session — callers respond 401 (brokers) or render the
 * token prompt (page).
 */
export async function resolveShareVisitor(
  cookieHeader: string | null,
  share: Share,
): Promise<ShareVisitor | null> {
  if (shareModeOf(share) === 'public') return { mode: 'public', contactId: null };
  for (const value of teamCookieValues(cookieHeader)) {
    const claims = verifyTeamVisitorValue(value);
    if (!claims || claims.shareId !== share.id) continue;
    // Liveness: the cookie is necessary but never sufficient.
    if (await isTeamMember(share.ownerId, claims.contactId)) {
      return { mode: 'team', contactId: claims.contactId };
    }
  }
  return null;
}
