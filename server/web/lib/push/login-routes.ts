// The push routes of a MEMBER login (migration mobile_roles_push,
// docs/mobile-companion-backend.md "Every login on the phone"): the same
// steps as the admin's /api/push/*, for the caller's OWN devices and its own
// toggles. The route files under /api/member/push gate the login
// (getMemberOr401) and call these. (There is no client login.)
//
// A device is enrolled by the phone app, which signs in with a device token:
// the enrol step needs that bearer, records its token, and the send path
// pushes to the device only while the token is live.

import { NextResponse } from '@/server/http-compat';
import { bearerFrom, verifyMobileToken } from '@/lib/auth';
import { loadBearerToken } from '@/lib/auth/login-row';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { readJsonNoNul } from '@/lib/strip-nul';
import { connectDevice, parseConnectBody } from './connect';
import { sanitizeLoginPushPrefs } from './preferences-sanitize';
import {
  deleteOwnSubscription,
  forgetRelayDevices,
  getLoginPushPrefs,
  insertSubscription,
  listOwnDevices,
  updateLoginPushPrefs,
} from './store';
import { UUID_RE } from '@mantle/std';

export type LoginPushCaller = {
  role: 'member';
  loginId: string;
  anchorId: string;
  email: string;
};

const invalidBody = () => NextResponse.json({ error: 'invalid_body' }, { status: 400 });

/**
 * The device token the request carries, when it is a live token of THIS
 * login. The session may have resolved from a cookie while the header holds
 * someone else's bearer, so the token row is checked against the caller.
 */
export async function callerTokenId(req: Request, loginId: string): Promise<string | null> {
  const token = bearerFrom(req);
  const claims = token ? verifyMobileToken(token) : null;
  if (!claims || claims.uid !== loginId) return null;
  const row = await loadBearerToken(claims.jti);
  if (!row || row.revokedAt || row.userId !== loginId) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return claims.jti;
}

/** POST {pushBase}/connect { platform, osPushToken } -> { ticket, relayUrl }. */
export async function loginPushConnect(req: Request, caller: LoginPushCaller): Promise<Response> {
  // Connect and enrol are once-per-install steps: the gate took the row's
  // limit (lib/route-limits.ts pushEnrol: 10 a minute per login, one bucket
  // for both, the admin routes too).
  const body = parseConnectBody(await readJsonNoNul(req));
  if (!body) return invalidBody();
  // A member may switch the brain's push link on.
  const res = await connectDevice(body.osPushToken, { mayRegister: true });
  if (res.ok) {
    // A member's Connect was the brain's first: the admins can see who
    // registered the brain with the relay, and when.
    if (res.registered) {
      auditFireAndForget({
        actorId: caller.loginId,
        actorEmail: caller.email,
        action: 'push.relay_registered',
        method: 'POST',
        path: `/api/${caller.role}/push/connect`,
        detail: { role: caller.role, relayUrl: res.relayUrl },
        ...requestMetaFrom(req),
      });
    }
    return NextResponse.json({ ticket: res.ticket, relayUrl: res.relayUrl });
  }
  if (res.error === 'push_not_set_up') {
    return NextResponse.json({ error: 'push_not_set_up' }, { status: 409 });
  }
  console.error('[push] relay unreachable:', res.reason);
  return NextResponse.json({ error: 'relay_unreachable' }, { status: 502 });
}

/** POST {pushBase}/subscriptions: store the device the app just enrolled. */
export async function loginPushSubscribe(req: Request, caller: LoginPushCaller): Promise<Response> {
  // The row's limit (pushEnrol) is the gate's.
  const tokenId = await callerTokenId(req, caller.loginId);
  if (!tokenId) return NextResponse.json({ error: 'bearer_required' }, { status: 400 });
  const body = ((await readJsonNoNul(req)) ?? {}) as Record<string, unknown>;
  const { routingToken, publicKey, platform } = body;
  if (
    typeof routingToken !== 'string' ||
    !routingToken ||
    routingToken.length > 512 ||
    typeof publicKey !== 'string' ||
    !publicKey ||
    publicKey.length > 512 ||
    (platform !== 'ios' && platform !== 'android')
  ) {
    return invalidBody();
  }
  const label = typeof body['label'] === 'string' ? body['label'].trim().slice(0, 80) : null;
  const relayDeviceId =
    typeof body['deviceId'] === 'string' ? body['deviceId'].slice(0, 200) : null;
  const { id, dropped } = await insertSubscription({
    ownerId: caller.anchorId,
    loginId: caller.loginId,
    tokenId,
    routingToken,
    publicKey,
    platform,
    label: label || null,
    relayDeviceId,
  });
  // Devices over the cap were dropped (the oldest): tell the relay.
  await forgetRelayDevices(dropped);
  return NextResponse.json({ id });
}

/** GET {pushBase}/subscriptions: the caller's own devices (metadata only). */
export async function loginPushDevices(req: Request, caller: LoginPushCaller): Promise<Response> {
  const [devices, current] = await Promise.all([
    listOwnDevices(caller.loginId),
    callerTokenId(req, caller.loginId),
  ]);
  return NextResponse.json({
    devices: devices.map((d) => ({
      id: d.id,
      platform: d.platform,
      label: d.label,
      current: !!current && d.tokenId === current,
    })),
  });
}

/** DELETE {pushBase}/subscriptions/:id: unpair one of the caller's devices. */
export async function loginPushUnpair(caller: LoginPushCaller, id: string): Promise<Response> {
  const routingToken = UUID_RE.test(id) ? await deleteOwnSubscription(caller.loginId, id) : null;
  if (!routingToken) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  // Best effort, as every unpair: the row is gone either way.
  await forgetRelayDevices([routingToken]);
  return NextResponse.json({ ok: true });
}

/** GET {pushBase}/preferences. */
export async function loginPushPrefs(caller: LoginPushCaller): Promise<Response> {
  return NextResponse.json(await getLoginPushPrefs(caller.loginId));
}

/** PUT {pushBase}/preferences: a partial patch; unknown fields are ignored. */
export async function loginPushPrefsUpdate(
  req: Request,
  caller: LoginPushCaller,
): Promise<Response> {
  const body = (await readJsonNoNul(req)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalidBody();
  return NextResponse.json(
    await updateLoginPushPrefs(caller.loginId, sanitizeLoginPushPrefs(body)),
  );
}
