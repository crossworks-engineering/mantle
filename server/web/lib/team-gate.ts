/**
 * Visitor resolution for the /s/<token> share surface.
 *
 * Public-mode shares admit anyone (the original model). Team-mode shares
 * require a live team credential — either the share-scoped team-visitor cookie
 * minted by POST /s/<token>/auth, or the brain-level team-chat cookie minted on
 * the /team hub (so a member browsing from the hub never re-enters their token
 * for every briefing). The APP brokers (bundle/tool-broker/db-broker) also
 * accept the signed team-chat value as `Authorization: Bearer` — the split
 * client's hub runs the app sandbox on its own origin, and cookies don't cross
 * origins (see resolveShareVisitorFromRequest). Any way in, membership
 * LIVENESS is re-checked against contact_team_tokens on every call, so
 * removing someone from the team locks them out mid-session, cookie or not.
 */
import { shareModeOf, isTeamMember } from '@mantle/content';
import type { Share } from '@mantle/db';
import {
  TEAM_CHAT_COOKIE,
  TEAM_VISITOR_COOKIE,
  verifyTeamChatValue,
  verifyTeamVisitorValue,
} from '@/lib/auth';

export type ShareVisitor =
  { mode: 'public'; contactId: null } | { mode: 'team'; contactId: string };

/** Every value of `name` in a raw Cookie header. Path scoping means at most
 *  one normally arrives, but parse liberally. */
function cookieValues(cookieHeader: string | null, name: string): string[] {
  if (!cookieHeader) return [];
  const out: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
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
  // Share-scoped visitor cookie (minted at this share's own token prompt).
  for (const value of cookieValues(cookieHeader, TEAM_VISITOR_COOKIE)) {
    const claims = verifyTeamVisitorValue(value);
    if (!claims || claims.shareId !== share.id) continue;
    // Liveness: the cookie is necessary but never sufficient.
    if (await isTeamMember(share.ownerId, claims.contactId)) {
      return { mode: 'team', contactId: claims.contactId };
    }
  }
  // Brain-level team-chat cookie (minted on /team). Same trust — a live team
  // member of THIS brain — so it opens this brain's team-mode shares too.
  for (const value of cookieValues(cookieHeader, TEAM_CHAT_COOKIE)) {
    const claims = verifyTeamChatValue(value);
    if (!claims || claims.ownerId !== share.ownerId) continue;
    if (await isTeamMember(claims.ownerId, claims.contactId)) {
      return { mode: 'team', contactId: claims.contactId };
    }
  }
  return null;
}

/**
 * Request-level visitor resolution for the APP broker routes (bundle,
 * tool-broker, db-broker) — the only /s sub-paths the split client calls
 * cross-origin (its hub runs the app sandbox on its own origin, where the
 * parent-page fetches can carry a header but never a cookie). Accepts the
 * signed team-chat value as `Authorization: Bearer` with the SAME trust as the
 * cookie path — right brain + live membership — else falls back to the cookie
 * resolver. An explicit-but-bad bearer never falls through to the cookie
 * (mirrors resolveTeamChatCaller).
 */
export async function resolveShareVisitorFromRequest(
  req: Request,
  share: Share,
): Promise<ShareVisitor | null> {
  if (shareModeOf(share) === 'public') return { mode: 'public', contactId: null };
  const authz = req.headers.get('authorization');
  if (authz?.toLowerCase().startsWith('bearer ')) {
    const claims = verifyTeamChatValue(authz.slice(7).trim());
    if (
      claims &&
      claims.ownerId === share.ownerId &&
      (await isTeamMember(claims.ownerId, claims.contactId))
    ) {
      return { mode: 'team', contactId: claims.contactId };
    }
    return null;
  }
  return resolveShareVisitor(req.headers.get('cookie'), share);
}
