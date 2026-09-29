/**
 * POST /api/auth/client-link { code, email } (public, under /api/auth): a
 * CLIENT login signs in with the link an admin issued (client logins,
 * Phase C2). The client types their email on the link page as a check.
 * One transaction locks the link, checks the login (an active client with
 * that email) and marks the link used (redeemClientSigninLink); then the
 * 30-day client session cookie is set.
 *
 * Every failure (unknown, used, revoked or expired code; a wrong email; a
 * disabled login; a malformed body) is the same 401, so the route is no
 * oracle. Rate limited per address (an IPv6 caller by its /64) before any
 * lookup; no brain-wide cap, so a stranger cannot hold every client out
 * (lib/client-logins.ts, audit B11).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { redeemClientSigninLink } from '@mantle/content';
import type { ClientLinkSignIn } from '@mantle/client-types';
import { setClientSessionCookie } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { clientLinkRateLimited } from '@/lib/client-logins';
import { refuseCrossSiteAuthPost } from '@/lib/auth/preflight';

const Body = z.object({
  code: z.string().min(1).max(64),
  email: z.string().trim().min(3).max(320),
});

const FAILED_MESSAGE = 'This sign-in link is not valid. Ask for a new one.';

export async function POST(req: Request) {
  const refused = refuseCrossSiteAuthPost(req);
  if (refused) return refused;
  const limited = clientLinkRateLimited(req);
  if (limited) return limited;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  const redeemed = parsed.success ? await redeemClientSigninLink(parsed.data) : null;
  if (!redeemed) {
    auditFireAndForget({
      actorEmail: (parsed.success && parsed.data.email.toLowerCase()) || '(client link)',
      action: 'auth.client_link_failed',
      method: 'POST',
      path: '/api/auth/client-link',
      ...requestMetaFrom(req),
    });
    return NextResponse.json({ error: FAILED_MESSAGE }, { status: 401 });
  }

  auditFireAndForget({
    actorId: redeemed.loginId,
    actorEmail: redeemed.email,
    action: 'auth.client_link_signin',
    method: 'POST',
    path: '/api/auth/client-link',
    detail: { linkId: redeemed.linkId },
    ...requestMetaFrom(req),
  });
  const body: ClientLinkSignIn = { ok: true };
  const res = NextResponse.json(body);
  setClientSessionCookie(res, req, redeemed.loginId, redeemed.sessionEpoch);
  return res;
}
