/**
 * POST /api/auth/client-code/verify { email, code } (public, under
 * /api/auth): a CLIENT login signs in with the code it was mailed (client
 * logins C2b). The code belongs to the browser that asked for it: the
 * request cookie names the request, and the code is looked up by it, so a
 * code forwarded to another browser opens nothing. Success sets the 30-day
 * client session cookie (at the login's epoch) and clears the request
 * cookie.
 *
 * Every failure (no request cookie, unknown, used, expired or dead code, a
 * wrong code or email, a disabled login, a malformed body) is the same 401.
 * Rate limited per address, and failed tries per email plus address; there
 * is no brain-wide failure lockout (lib/client-logins.ts).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { redeemClientEmailCode } from '@mantle/content';
import type { ClientCodeSignIn } from '@mantle/client-types';
import { setClientSessionCookie } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import {
  clearClientCodeCookie,
  clientCodeVerifyFailed,
  clientCodeVerifyLimited,
  existingRequestId,
} from '@/lib/client-logins';
import { refuseCrossSiteAuthPost } from '@/lib/auth/preflight';
import { AUTH_BODY_CEILING_BYTES, readJsonCapped } from '@/lib/body-limit';

const Body = z.object({
  email: z.string().trim().min(3).max(320),
  code: z.string().trim().min(1).max(32),
});

const FAILED_MESSAGE = 'That code did not work. Ask for a new one.';

export async function POST(req: Request) {
  const refused = refuseCrossSiteAuthPost(req);
  if (refused) return refused;
  const parsed = Body.safeParse(await readJsonCapped(req, AUTH_BODY_CEILING_BYTES));
  const email = parsed.success ? parsed.data.email.toLowerCase() : '';
  const limited = clientCodeVerifyLimited(req, email);
  if (limited) return limited;

  const requestId = existingRequestId(req);
  const redeemed =
    parsed.success && requestId
      ? await redeemClientEmailCode({ requestId, email, code: parsed.data.code })
      : null;
  if (!redeemed) {
    clientCodeVerifyFailed(req, email);
    auditFireAndForget({
      actorEmail: email || '(client code)',
      action: 'auth.client_code_failed',
      method: 'POST',
      path: '/api/auth/client-code/verify',
      ...requestMetaFrom(req),
    });
    return NextResponse.json({ error: FAILED_MESSAGE }, { status: 401 });
  }

  auditFireAndForget({
    actorId: redeemed.loginId,
    actorEmail: redeemed.email,
    action: 'auth.client_code_signin',
    method: 'POST',
    path: '/api/auth/client-code/verify',
    detail: { codeId: redeemed.codeId },
    ...requestMetaFrom(req),
  });
  const body: ClientCodeSignIn = { ok: true };
  const res = NextResponse.json(body);
  setClientSessionCookie(res, req, redeemed.loginId, redeemed.sessionEpoch);
  clearClientCodeCookie(res, req);
  return res;
}
