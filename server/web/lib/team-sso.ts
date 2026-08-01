/**
 * The team SSO handoff handler — POST /api/team/sso (route re-exports this;
 * lives in lib with relative imports so the co-located vitest run resolves it,
 * same pattern as token-login.ts).
 *
 * The split client app holds the member's signed team-chat credential in
 * localStorage; the /s share surface authenticates by cookie on the SERVER
 * origin. Cross-origin iframes never receive a Lax cookie (and third-party
 * cookies are dying anyway), so the client opens shares TOP-LEVEL through this
 * route: a plain form POST (target=_blank) carrying the bearer in the BODY —
 * never a URL, so it can't leak into access logs, history, or Referer. We
 * verify it exactly like the API gate (signature + membership liveness), mint
 * a FRESH team-chat cookie first-party, and 303 to the share.
 *
 * `next` is constrained to a single /s/<token> path segment — widen the regex
 * deliberately if /s ever grows deep links, never to a startsWith('/') check
 * (open redirect). The Origin check is cheap login-CSRF hardening: only our
 * own origins may pin a browser's server-origin team session to an identity.
 *
 * `next` may also be ABSENT: verify the bearer, set the cookie, answer 204,
 * no redirect. That's the silent bearer→cookie upgrade the same-origin /team
 * workspace fires once per session, so members who authenticated in bearer
 * mode (the pre-v0.204 same-origin mis-detection) regain the cookie that the
 * share asset/HTML surfaces authenticate by — without re-entering a token.
 */
import { NextResponse } from '../server/http-compat';
import { isTeamMember } from '@mantle/content';
import { buildTeamChatToken, verifyTeamChatValue, TEAM_CHAT_COOKIE } from './auth';
import { isTrustedOrigin, rateLimited } from './auth/preflight';
import { secureCookies, requestOrigin } from './auth-constants';
import { rateLimit, clientIp } from './rate-limit';

const NEXT_RE = /^\/s\/[A-Za-z0-9_-]+$/;

function denied(status: 401 | 403) {
  return NextResponse.json({ ok: false, error: 'invalid team session' }, { status });
}

export async function handleTeamSso(req: Request): Promise<NextResponse> {
  const limited = rateLimited(
    rateLimit(`team-sso:ip:${clientIp(req)}`, { max: 30, windowMs: 60_000 }),
  );
  if (limited) return limited;

  // A browser form navigation always sends Origin on cross-origin POSTs.
  if (!isTrustedOrigin(req)) return denied(403);

  const form = await req.formData().catch(() => null);
  const tb = form?.get('tb');
  const next = form?.get('next') ?? null;
  if (typeof tb !== 'string') return denied(403);
  // Present ⇒ must be a valid /s path. Absent ⇒ the cookie-upgrade shape.
  if (next !== null && (typeof next !== 'string' || !NEXT_RE.test(next))) {
    return denied(403);
  }

  const claims = verifyTeamChatValue(tb.trim());
  if (!claims) return denied(401);
  // Liveness: the signed value is necessary but never sufficient.
  if (!(await isTeamMember(claims.ownerId, claims.contactId))) return denied(401);

  const minted = buildTeamChatToken(claims.ownerId, claims.contactId);
  const res =
    next === null
      ? new NextResponse(null, { status: 204 })
      : NextResponse.redirect(new URL(next, requestOrigin(req)), 303);
  res.cookies.set(TEAM_CHAT_COOKIE, minted.value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(req),
    path: '/',
    maxAge: minted.maxAgeSec,
  });
  return res;
}
