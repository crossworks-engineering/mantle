/**
 * Visitor resolution for the /s/<token> share surface.
 *
 * Public-mode shares admit anyone (the original model). Team-mode shares
 * require a live team credential: the share-scoped team-visitor cookie minted
 * by POST /s/<token>/auth. Membership LIVENESS is re-checked against
 * contact_team_tokens on every call, so removing someone from the team locks
 * them out mid-session, cookie or not.
 *
 * The brain-level team-chat credential (the `mantle_team_chat` cookie, and the
 * same signed value as `Authorization: Bearer` from the client's /hub) no
 * longer admits anyone: /team, /hub and /api/team/* were retired in member
 * logins Phase 6, and nothing mints it any more.
 */
import { shareModeOf, isTeamMember } from '@mantle/content';
import type { Share } from '@mantle/db';
import { TEAM_VISITOR_COOKIE, verifyTeamVisitorValue } from '@/lib/auth';
import { cookieValues } from '@/lib/auth/request';

export type ShareVisitor =
  { mode: 'public'; contactId: null } | { mode: 'team'; contactId: string };

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
  // Share-scoped visitor cookie (minted at this share's own token prompt).
  for (const value of cookieValues(cookieHeader, TEAM_VISITOR_COOKIE)) {
    const claims = verifyTeamVisitorValue(value);
    if (!claims || claims.shareId !== share.id) continue;
    // Liveness: the cookie is necessary but never sufficient.
    if (await isTeamMember(share.ownerId, claims.contactId)) {
      return { mode: 'team', contactId: claims.contactId };
    }
  }
  return null;
}

/**
 * Request-level visitor resolution for the /s broker routes. The share-scoped
 * visitor cookie is the only team credential; a bearer header is ignored
 * (the team-chat bearer it once accepted is retired).
 */
export async function resolveShareVisitorFromRequest(
  req: Request,
  share: Share,
): Promise<ShareVisitor | null> {
  return resolveShareVisitor(req.headers.get('cookie'), share);
}
