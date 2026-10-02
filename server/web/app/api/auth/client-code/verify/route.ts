/**
 * POST /api/auth/client-code/verify { email, code } (public, under
 * /api/auth): a CLIENT login signs in with the code it was mailed (client
 * logins C2b). The code belongs to the browser that asked for it: the
 * request cookie names the request, and the code is looked up by it, so a
 * code forwarded to another browser opens nothing. Success sets the 30-day
 * client session cookie (at the login's epoch) and clears the request
 * cookie.
 *
 * Device mode, for the phone app (docs/mobile-companion-backend.md): a body
 * with `requestId` (what POST /api/auth/client-code answered in device mode)
 * names the request itself. Success then answers a per-device bearer for the
 * client login and sets NO cookie: 30 days, signed with the login's session
 * epoch, a mobile_tokens row like every device (listed and revoked under the
 * login's devices; ended by the client's sign-out and by End sessions). The
 * row is written in the redeem's own transaction. The code is looked up
 * under the id derived from the app's (deviceRequestId): a browser's request
 * id in the body opens nothing. A request with `Origin` or a `Sec-Fetch-*`
 * header is a page, not the app: 403 `device-only`. The device name is a
 * label: clamped, never a reason to refuse.
 *
 * Every failure (no request cookie, unknown, used, expired or dead code, a
 * wrong code or email, a disabled login, a malformed body) is the same 401.
 * Rate limited per address, and failed tries per email plus address; there
 * is no brain-wide failure lockout (lib/client-logins.ts).
 */
import { NextResponse } from '@/server/http-compat';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { redeemClientEmailCode } from '@mantle/content';
import type { ClientCodeSignIn } from '@mantle/client-types';
import { CLIENT_SESSION_TTL_SECONDS, buildMobileToken, setClientSessionCookie } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import {
  clearClientCodeCookie,
  clientCodeVerifyFailed,
  clientCodeVerifyLimited,
  deviceRequestId,
  existingRequestId,
  refuseBrowserDeviceMode,
  requestIdFrom,
} from '@/lib/client-logins';
import { deviceLabel } from '@/lib/token-login';
import { refuseCrossSiteAuthPost } from '@/lib/auth/preflight';
import { AUTH_BODY_CEILING_BYTES, readJsonCapped } from '@/lib/body-limit';
import { brainIdField } from '@/lib/brain-identity';

const Body = z.object({
  email: z.string().trim().min(3).max(320),
  code: z.string().trim().min(1).max(32),
  // Device mode: the request id the app was given, and a name for the device.
  requestId: z.string().trim().max(64).optional(),
  deviceName: z.unknown().optional(),
});

const FAILED_MESSAGE = 'That code did not work. Ask for a new one.';

export async function POST(req: Request) {
  const refused = refuseCrossSiteAuthPost(req);
  if (refused) return refused;
  const parsed = Body.safeParse(await readJsonCapped(req, AUTH_BODY_CEILING_BYTES));
  const email = parsed.success ? parsed.data.email.toLowerCase() : '';
  const limited = clientCodeVerifyLimited(req, email);
  if (limited) return limited;

  // Device mode is the body's request id, and then ONLY that: the cookie is
  // not a fallback (a malformed id is a failure, not a browser sign-in).
  const data = parsed.success ? parsed.data : null;
  const device = data?.requestId !== undefined;
  if (device) {
    const notTheApp = refuseBrowserDeviceMode(req);
    if (notTheApp) return notTheApp;
  }
  const appRequestId = device ? requestIdFrom(data?.requestId) : null;
  const requestId = device ? appRequestId && deviceRequestId(appRequestId) : existingRequestId(req);
  const jti = randomUUID();
  const label = deviceLabel(data?.deviceName, 'Mobile device');
  const redeemed =
    data && requestId
      ? await redeemClientEmailCode(
          { requestId, email, code: data.code },
          new Date(),
          device ? { device: { id: jti, label, ttlSeconds: CLIENT_SESSION_TTL_SECONDS } } : {},
        )
      : null;
  if (!redeemed) {
    clientCodeVerifyFailed(req, email);
    auditFireAndForget({
      actorEmail: email || '(client code)',
      action: 'auth.client_code_failed',
      method: 'POST',
      path: '/api/auth/client-code/verify',
      ...(device ? { detail: { channel: 'mobile' } } : {}),
      ...requestMetaFrom(req),
    });
    return NextResponse.json({ error: FAILED_MESSAGE }, { status: 401 });
  }

  // After the redeem committed (in device mode the token row with it).
  auditFireAndForget({
    actorId: redeemed.loginId,
    actorEmail: redeemed.email,
    action: 'auth.client_code_signin',
    method: 'POST',
    path: '/api/auth/client-code/verify',
    detail: {
      codeId: redeemed.codeId,
      ...(device ? { channel: 'mobile', device: label, deviceId: jti } : {}),
    },
    ...requestMetaFrom(req),
  });
  if (device) {
    const minted = buildMobileToken(
      redeemed.loginId,
      jti,
      CLIENT_SESSION_TTL_SECONDS,
      redeemed.sessionEpoch,
    );
    return NextResponse.json(
      {
        ok: true,
        token: minted.value,
        expiresIn: minted.expiresInSec,
        expiresAt: minted.expiresAt.toISOString(),
        deviceId: jti,
        role: 'client',
        loginId: redeemed.loginId,
        // This brain: with loginId, the key the app files the session under.
        ...(await brainIdField()),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const body: ClientCodeSignIn = { ok: true };
  const res = NextResponse.json(body);
  setClientSessionCookie(res, req, redeemed.loginId, redeemed.sessionEpoch);
  clearClientCodeCookie(res, req);
  return res;
}
